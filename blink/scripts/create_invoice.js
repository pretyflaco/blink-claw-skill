#!/usr/bin/env node
/**
 * Blink Wallet - Create Lightning Invoice
 *
 * Usage: node create_invoice.js <amount_sats> [memo]
 *
 * Creates a Lightning invoice (BOLT-11) for the specified amount in satoshis.
 * Automatically resolves the BTC wallet ID from the account.
 *
 * Arguments:
 *   amount_sats  - Required. Amount in satoshis.
 *   memo         - Optional. Memo to attach to the invoice.
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

const CREATE_INVOICE_MUTATION = `
  mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
    lnInvoiceCreate(input: $input) {
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

async function getBtcWalletId() {
  const data = await graphqlRequest(WALLET_QUERY);
  if (!data.me) throw new Error('Authentication failed. Check your BLINK_API_KEY.');
  const btcWallet = data.me.defaultAccount.wallets.find(w => w.walletCurrency === 'BTC');
  if (!btcWallet) throw new Error('No BTC wallet found on this account.');
  return btcWallet.id;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node create_invoice.js <amount_sats> [memo]');
    process.exit(1);
  }

  const amountSats = parseInt(args[0], 10);
  if (isNaN(amountSats) || amountSats <= 0) {
    console.error('Error: amount_sats must be a positive integer');
    process.exit(1);
  }

  const memo = args.slice(1).join(' ') || undefined;

  // Auto-resolve BTC wallet ID
  const walletId = await getBtcWalletId();

  const input = {
    walletId,
    amount: amountSats,
  };
  if (memo) input.memo = memo;

  const data = await graphqlRequest(CREATE_INVOICE_MUTATION, { input });
  const result = data.lnInvoiceCreate;

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Invoice creation failed: ${result.errors.map(e => e.message).join(', ')}`);
  }

  if (!result.invoice) {
    throw new Error('Invoice creation returned no invoice and no errors.');
  }

  console.log(JSON.stringify({
    paymentRequest: result.invoice.paymentRequest,
    paymentHash: result.invoice.paymentHash,
    satoshis: result.invoice.satoshis,
    status: result.invoice.paymentStatus,
    createdAt: result.invoice.createdAt,
    walletId,
  }, null, 2));
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
