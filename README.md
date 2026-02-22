# blink-claw-skill

Blink Lightning wallet skill for OpenClaw agents.

## Contents

- `blink/SKILL.md` — Skill manifest and docs
- `blink/scripts/` — Self-contained Node.js CLI scripts

## Requirements

- Node.js 18+ (built-in `fetch`)
- Blink API key for wallet operations (price queries are public)

## Setup

```bash
export BLINK_API_KEY="blink_..."
```

(Optional) staging:
```bash
export BLINK_API_URL="https://api.staging.blink.sv/graphql"
```

## Quick start

```bash
# Balance (includes USD estimate)
node blink/scripts/balance.js

# Create BTC invoice
node blink/scripts/create_invoice.js 1000 "Payment"

# Convert sats to USD
node blink/scripts/price.js 1760
```

For full usage and command details, see `blink/SKILL.md`.
