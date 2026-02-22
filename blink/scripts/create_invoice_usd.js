#!/usr/bin/env node
/**
 * Blink Wallet - Create USD-Denominated Lightning Invoice
 *
 * Usage: node create_invoice_usd.js <amount_cents> [memo]
 *
 * Creates a Lightning invoice denominated in USD cents. The sender pays in
 * BTC/Lightning, but the amount received is locked to a USD value at the
 * exchange rate at invoice creation time. Credited to the USD wallet.
 *
 * NOTE: USD invoices have a short expiry (~5 minutes) because they lock
 * an exchange rate. Use BTC invoices (create_invoice.js) if you need
 * longer-lived invoices.
 *
 * Arguments:
 *   amount_cents  - Required. Amount in USD cents (e.g. 100 = $1.00).
 *   memo          - Optional. Memo to attach to the invoice.
 *
 * Environment:
 *   BLINK_API_KEY  - Required. Blink API key (format: blink_...)
 *   BLINK_API_URL  - Optional. Override API endpoint (default: https://api.blink.sv/graphql)
 *
 * Dependencies: None (uses Node.js built-in fetch)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_API_URL = 'https://api.blink.sv/graphql';

function getApiKey() {
  let key = process.env.BLINK_API_KEY;
  if (!key) {
    try {
      const profile = fs.readFileSync(path.join(os.homedir(), '.profile'), 'utf8');
      const match = profile.match(/BLINK_API_KEY=["']?([a-zA-Z0-9_]+)["']?/);
      if (match) key = match[1];
    } catch {}
  }
  if (!key) throw new Error('BLINK_API_KEY not found. Set it in environment or ~/.profile');
  return key;
}

function getApiUrl() {
  return process.env.BLINK_API_URL || DEFAULT_API_URL;
}

async function graphqlRequest(query, variables = {}) {
  const apiKey = getApiKey();
  const apiUrl = getApiUrl();

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL error: ${json.errors.map(e => e.message).join(', ')}`);
  }
  return json.data;
}

const WALLET_QUERY = `
  query Me {
    me {
      defaultAccount {
        wallets {
          id
          walletCurrency
        }
      }
    }
  }
`;

const CREATE_USD_INVOICE_MUTATION = `
  mutation LnUsdInvoiceCreate($input: LnUsdInvoiceCreateInput!) {
    lnUsdInvoiceCreate(input: $input) {
      invoice {
        paymentRequest
        paymentHash
        paymentSecret
        satoshis
        paymentStatus
        createdAt
      }
      errors {
        code
        message
        path
      }
    }
  }
`;

async function getUsdWalletId() {
  const data = await graphqlRequest(WALLET_QUERY);
  if (!data.me) throw new Error('Authentication failed. Check your BLINK_API_KEY.');
  const usdWallet = data.me.defaultAccount.wallets.find(w => w.walletCurrency === 'USD');
  if (!usdWallet) throw new Error('No USD wallet found on this account.');
  return usdWallet.id;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node create_invoice_usd.js <amount_cents> [memo]');
    console.error('  amount_cents: amount in USD cents (e.g. 100 = $1.00)');
    process.exit(1);
  }

  const amountCents = parseInt(args[0], 10);
  if (isNaN(amountCents) || amountCents <= 0) {
    console.error('Error: amount_cents must be a positive integer');
    process.exit(1);
  }

  const memo = args.slice(1).join(' ') || undefined;

  // Auto-resolve USD wallet ID
  const walletId = await getUsdWalletId();

  const input = {
    walletId,
    amount: amountCents,
  };
  if (memo) input.memo = memo;

  const data = await graphqlRequest(CREATE_USD_INVOICE_MUTATION, { input });
  const result = data.lnUsdInvoiceCreate;

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Invoice creation failed: ${result.errors.map(e => e.message).join(', ')}`);
  }

  if (!result.invoice) {
    throw new Error('Invoice creation returned no invoice and no errors.');
  }

  const usdFormatted = `$${(amountCents / 100).toFixed(2)}`;
  console.error(`Created USD invoice for ${usdFormatted} (${result.invoice.satoshis} sats at current rate)`);
  console.error('Note: USD invoices expire in ~5 minutes due to exchange rate lock.');

  console.log(JSON.stringify({
    paymentRequest: result.invoice.paymentRequest,
    paymentHash: result.invoice.paymentHash,
    satoshis: result.invoice.satoshis,
    amountCents,
    amountUsd: usdFormatted,
    status: result.invoice.paymentStatus,
    createdAt: result.invoice.createdAt,
    walletId,
    walletCurrency: 'USD',
  }, null, 2));
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
