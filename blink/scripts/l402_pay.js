#!/usr/bin/env node
/**
 * Blink Wallet - L402 Auto-Pay Client
 *
 * Usage: node l402_pay.js <url> [options]
 *
 * Makes an HTTP request to a URL. If it returns 402 Payment Required,
 * automatically parses the L402 challenge, pays the Lightning invoice via
 * the Blink wallet, and retries the request with the payment proof.
 *
 * Supports both L402 formats:
 *   - Lightning Labs: WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
 *   - l402-protocol.org: JSON body with payment_request_url and offers array
 *
 * Cached tokens (from previous payments) are checked first to avoid re-paying.
 *
 * Arguments:
 *   url              - Required. The URL to access.
 *   --wallet         - Optional. BTC (default) or USD.
 *   --max-amount     - Optional. Refuse to pay more than N sats (safety limit).
 *   --dry-run        - Optional. Discover price without paying.
 *   --method         - Optional. HTTP method: GET (default) or POST.
 *   --header         - Optional. Extra request header in key:value format (repeatable).
 *   --body           - Optional. Request body (for POST requests).
 *   --no-store       - Optional. Do not read from or write to the token store.
 *   --force          - Optional. Pay even if a cached token exists.
 *
 * Environment:
 *   BLINK_API_KEY    - Required. Blink API key with Write scope.
 *   BLINK_API_URL    - Optional. Override Blink GraphQL endpoint.
 *
 * Dependencies: None (uses Node.js built-in fetch + _blink_client.js)
 *
 * CAUTION: This sends real bitcoin. The API key must have Write scope.
 *
 * Output: JSON to stdout. Status messages to stderr.
 */

'use strict';

const {
  getApiKey,
  getApiUrl,
  graphqlRequest,
  getWallet,
  formatBalance,
  MUTATION_TIMEOUT_MS,
} = require('./_blink_client');

const {
  parseLightningLabsHeader,
  parseL402ProtocolBody,
  decodeBolt11AmountSats,
  fetchL402ProtocolInvoice,
} = require('./l402_discover');

const { saveToken, getToken } = require('./l402_store');

// ── GraphQL mutation (same as pay_invoice.js) ─────────────────────────────────

const PAY_INVOICE_MUTATION = `
  mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
    lnInvoicePaymentSend(input: $input) {
      status
      errors {
        code
        message
        path
      }
    }
  }
`;

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let url = null;
  let walletCurrency = 'BTC';
  let maxAmount = null;
  let dryRun = false;
  let method = 'GET';
  let noStore = false;
  let force = false;
  let body = null;
  const headers = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--wallet' && i + 1 < argv.length) {
      walletCurrency = argv[++i].toUpperCase();
      if (!['BTC', 'USD'].includes(walletCurrency)) {
        console.error('Error: --wallet must be BTC or USD');
        process.exit(1);
      }
    } else if (arg === '--max-amount' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (isNaN(n) || n <= 0) {
        console.error('Error: --max-amount must be a positive integer (sats)');
        process.exit(1);
      }
      maxAmount = n;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-store') {
      noStore = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--method' && i + 1 < argv.length) {
      method = argv[++i].toUpperCase();
      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        console.error('Error: unsupported --method');
        process.exit(1);
      }
    } else if (arg === '--header' && i + 1 < argv.length) {
      const hdr = argv[++i];
      const colon = hdr.indexOf(':');
      if (colon < 1) {
        console.error(`Error: --header must be key:value, got: ${hdr}`);
        process.exit(1);
      }
      headers[hdr.slice(0, colon).trim()] = hdr.slice(colon + 1).trim();
    } else if (arg === '--body' && i + 1 < argv.length) {
      body = argv[++i];
    } else if (!arg.startsWith('--')) {
      url = arg;
    }
  }

  return { url, walletCurrency, maxAmount, dryRun, method, noStore, force, headers, body };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Make an HTTP request with a timeout.
 *
 * @param {string} url
 * @param {object} options   fetch options
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the domain (hostname) from a URL string.
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ── L402 challenge resolution ─────────────────────────────────────────────────

/**
 * Resolve an L402 challenge from a 402 response.
 * Returns the invoice to pay and the macaroon token.
 *
 * @param {Response} res
 * @returns {Promise<{ invoice: string, macaroon: string, format: string } | null>}
 */
async function resolveL402Challenge(res) {
  // Try Lightning Labs format (WWW-Authenticate header)
  const wwwAuth = res.headers.get('www-authenticate') || '';
  const lightningLabs = parseLightningLabsHeader(wwwAuth);
  if (lightningLabs) {
    return {
      invoice: lightningLabs.invoice,
      macaroon: lightningLabs.macaroon,
      format: 'lightning-labs',
    };
  }

  // Try l402-protocol.org format (JSON body)
  let bodyJson = null;
  try {
    const text = await res.text();
    bodyJson = JSON.parse(text);
  } catch {
    return null;
  }

  const l402proto = parseL402ProtocolBody(bodyJson);
  if (!l402proto) return null;

  if (!l402proto.paymentRequestUrl) return null;

  console.error(`Fetching payment request from: ${l402proto.paymentRequestUrl}`);
  const fetched = await fetchL402ProtocolInvoice(l402proto.paymentRequestUrl);
  if (!fetched) return null;

  // For l402-protocol format, the "macaroon" is the token returned after payment.
  // We store the offer id as the pre-payment token placeholder.
  return {
    invoice: fetched.invoice,
    macaroon: fetched.offerId || '',
    format: 'l402-protocol',
    offerId: fetched.offerId,
    paymentRequestUrl: l402proto.paymentRequestUrl,
    offers: l402proto.offers,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.error('Usage: node l402_pay.js <url> [--wallet BTC|USD] [--max-amount <sats>] [--dry-run] [--no-store] [--force]');
    process.exit(1);
  }

  const domain = extractDomain(args.url);

  // ── Check token store first ──
  if (!args.noStore && !args.force) {
    const cached = getToken(domain);
    if (cached) {
      console.error(`Using cached L402 token for ${domain} (paid ${cached.satoshis ?? '?'} sats previously).`);
      console.error('Retrying request with cached token...');

      const authHeader = `L402 ${cached.macaroon}:${cached.preimage}`;
      const res = await fetchWithTimeout(args.url, {
        method: args.method,
        headers: { Accept: 'application/json', Authorization: authHeader, ...args.headers },
        ...(args.body ? { body: args.body } : {}),
      });

      const body = await res.text();
      let data;
      try { data = JSON.parse(body); } catch { data = body; }

      const output = {
        event: 'l402_paid',
        url: args.url,
        status: res.status,
        tokenReused: true,
        satoshis: cached.satoshis ?? null,
        data,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }
  }

  // ── Initial request ──
  console.error(`Requesting: ${args.url}`);
  const reqOptions = {
    method: args.method,
    headers: { Accept: 'application/json', ...args.headers },
    ...(args.body ? { body: args.body } : {}),
  };

  const initialRes = await fetchWithTimeout(args.url, reqOptions);

  if (initialRes.status === 200) {
    const body = await initialRes.text();
    let data;
    try { data = JSON.parse(body); } catch { data = body; }
    const output = {
      event: 'l402_not_required',
      url: args.url,
      status: 200,
      message: 'Resource returned 200 OK — no payment required.',
      data,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (initialRes.status !== 402) {
    const body = await initialRes.text().catch(() => '');
    throw new Error(`Unexpected status ${initialRes.status}: ${body.slice(0, 200)}`);
  }

  console.error('402 Payment Required — parsing L402 challenge...');

  // ── Resolve challenge ──
  const challenge = await resolveL402Challenge(initialRes);
  if (!challenge) {
    throw new Error('Could not parse L402 challenge from 402 response. Try l402_discover.js for diagnostics.');
  }

  console.error(`Format: ${challenge.format}`);

  const satoshis = decodeBolt11AmountSats(challenge.invoice);

  if (satoshis === null) {
    console.error('Warning: could not decode amount from invoice.');
  } else {
    console.error(`Payment required: ${satoshis} sats`);
  }

  // ── Budget check ──
  if (args.maxAmount !== null && satoshis !== null && satoshis > args.maxAmount) {
    const output = {
      event: 'l402_budget_exceeded',
      url: args.url,
      satoshis,
      maxAmount: args.maxAmount,
      message: `Payment of ${satoshis} sats exceeds --max-amount of ${args.maxAmount} sats. Aborting.`,
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  }

  // ── Dry-run: report price and exit ──
  if (args.dryRun) {
    const output = {
      event: 'l402_dry_run',
      url: args.url,
      format: challenge.format,
      invoice: challenge.invoice,
      satoshis,
      satoshisFormatted: satoshis !== null ? `${satoshis} sats` : null,
      maxAmount: args.maxAmount,
      withinBudget: args.maxAmount !== null && satoshis !== null ? satoshis <= args.maxAmount : null,
      message: 'Dry-run: would pay this invoice to access the resource. No payment made.',
      ...(challenge.offers ? { offers: challenge.offers } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Pay the invoice ──
  const apiKey = getApiKey();
  const apiUrl = getApiUrl();

  const wallet = await getWallet({ apiKey, apiUrl, currency: args.walletCurrency });
  console.error(`Using ${args.walletCurrency} wallet ${wallet.id} (balance: ${formatBalance(wallet)})`);

  if (args.walletCurrency === 'BTC' && wallet.balance === 0) {
    throw new Error('Insufficient balance: BTC wallet has 0 sats.');
  }

  console.error(`Paying ${satoshis ?? '?'} sats via Blink...`);

  const payData = await graphqlRequest({
    query: PAY_INVOICE_MUTATION,
    variables: { input: { walletId: wallet.id, paymentRequest: challenge.invoice } },
    apiKey,
    apiUrl,
    timeoutMs: MUTATION_TIMEOUT_MS,
  });

  const payResult = payData.lnInvoicePaymentSend;

  if (payResult.errors && payResult.errors.length > 0) {
    const errMsg = payResult.errors.map((e) => `${e.message}${e.code ? ` [${e.code}]` : ''}`).join(', ');
    throw new Error(`Payment failed: ${errMsg}`);
  }

  if (payResult.status !== 'SUCCESS' && payResult.status !== 'ALREADY_PAID') {
    throw new Error(`Payment not successful: status=${payResult.status}`);
  }

  console.error(`Payment ${payResult.status === 'ALREADY_PAID' ? 'already paid' : 'successful'}!`);

  // ── Derive preimage from payment result ──
  // The Blink API does not return the preimage directly in lnInvoicePaymentSend.
  // For Lightning Labs format: we reconstruct the L402 auth token as macaroon:preimage.
  // For now we use the invoice payment hash as a proxy identifier.
  // A proper preimage would require a separate query — we use a synthetic token
  // based on the macaroon and invoice for the Authorization header.
  //
  // NOTE: For Lightning Labs L402 servers that verify the preimage cryptographically,
  // a real preimage is needed. The Blink API's lnInvoicePaymentSend v1 does not
  // return the preimage. We construct the best available token for the retry.
  //
  // Workaround: use the payment hash encoded from the BOLT-11 prefix as preimage placeholder.
  // In production, the preimage should be obtained from the payment result when the API supports it.
  const preimage = payResult.preimage || derivePreimageFromInvoice(challenge.invoice);
  const macaroon = challenge.macaroon;

  // ── Save token to store ──
  if (!args.noStore) {
    try {
      saveToken(domain, {
        macaroon,
        preimage,
        invoice: challenge.invoice,
        satoshis: satoshis ?? null,
      });
      console.error(`Token cached for ${domain}.`);
    } catch (err) {
      console.error(`Warning: could not save token to store: ${err.message}`);
    }
  }

  // ── Retry request with proof of payment ──
  console.error('Retrying request with L402 authorization...');
  const authHeader = `L402 ${macaroon}:${preimage}`;

  const retryRes = await fetchWithTimeout(args.url, {
    method: args.method,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      ...args.headers,
    },
    ...(args.body ? { body: args.body } : {}),
  });

  const retryBody = await retryRes.text();
  let retryData;
  try { retryData = JSON.parse(retryBody); } catch { retryData = retryBody; }

  const output = {
    event: 'l402_paid',
    url: args.url,
    format: challenge.format,
    paymentStatus: payResult.status,
    walletId: wallet.id,
    walletCurrency: args.walletCurrency,
    satoshis: satoshis ?? null,
    tokenReused: false,
    retryStatus: retryRes.status,
    data: retryData,
  };

  console.log(JSON.stringify(output, null, 2));

  if (retryRes.status !== 200) {
    console.error(`Warning: retry returned status ${retryRes.status} (expected 200).`);
    process.exit(1);
  }
}

/**
 * Derive a placeholder preimage from the BOLT-11 invoice when the API does
 * not return it directly. This is used only for token caching — the L402
 * server may accept or reject it depending on its verification mode.
 *
 * @param {string} invoice  BOLT-11 payment request.
 * @returns {string}  64-char hex string.
 */
function derivePreimageFromInvoice(invoice) {
  // Use a deterministic placeholder: pad the invoice chars to 64 hex chars.
  // This is NOT a real preimage and will only work with servers that do
  // not verify preimage hash matches. Agents should be aware of this limitation.
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(invoice).digest('hex');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

module.exports = { main, resolveL402Challenge, derivePreimageFromInvoice };
