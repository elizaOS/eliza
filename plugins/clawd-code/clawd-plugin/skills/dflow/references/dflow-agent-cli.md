# DFlow Agent CLI — Autonomous Trading Interface

## What This Covers

The DFlow Agent CLI is a purpose-built command-line interface for AI agents and automated systems to execute spot crypto, tokenized equity, and prediction market trades on Solana. It wraps DFlow's best-execution infrastructure in a deterministic, structured interface designed for machine consumption.

For programmatic API integration (building trading apps, UIs, backends), see `references/dflow-spot-trading.md` and `references/dflow-prediction-markets.md`. The Agent CLI is for autonomous agent execution — prompt to trade in a single command.

## When to Use the Agent CLI vs the API

| Use Case | Agent CLI | DFlow API |
|----------|-----------|-----------|
| AI agent executing trades autonomously | Yes | — |
| CI/CD or scripted trading workflows | Yes | — |
| Building a trading UI / web app | — | Yes |
| Custom transaction composition | — | Yes |
| Programmatic integration in code | — | Yes |
| Interactive terminal trading | Yes | — |

## Installation

```bash
curl -fsS https://cli.dflow.net | sh
```

Zero dependencies. Single command.

## Setup

```bash
dflow setup
```

Interactive configuration that sets:
- **Wallet name** — defaults to `default`, creates an encrypted wallet if new
- **Vault password** — minimum 12 characters
- **Solana RPC** — defaults to `https://api.mainnet-beta.solana.com` (override with a Helius RPC URL for better performance)
- **DFlow API key** — required, obtain from `https://pond.dflow.net/build/api-key`

Configuration saves to `~/.config/dflow/config.json`.

### Using Helius RPC

For optimal performance, configure the Agent CLI to use a Helius RPC endpoint:

```bash
# During setup, enter your Helius RPC URL when prompted:
# https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY

# Or override per-command:
dflow trade 1000000 USDC SOL --rpc-url https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
```

## Command Reference

### Setup & Identity

| Command | Purpose |
|---------|---------|
| `dflow setup` | Interactive configuration |
| `dflow whoami` | Display active wallet public key (raw string, not JSON envelope) |
| `dflow positions` | Show token balances with metadata (including outcome token positions) |
| `dflow agent --model <name>` | Register AI model name (48-hour cache) |

### Wallet Management

| Command | Purpose |
|---------|---------|
| `dflow wallet list` | List all named wallets |
| `dflow wallet import --name <n> --keypair <path>` | Import Solana keypair file |
| `dflow wallet import --name <n> --mnemonic "..."` | Import BIP-39 mnemonic |
| `dflow wallet export --name <n>` | Decrypt and print keypair |
| `dflow wallet delete --name <n> [--yes]` | Delete wallet |
| `dflow wallet rename --from <n> --to <n>` | Rename wallet |
| `dflow wallet keychain-sync --name <n>` | Resync OS keychain entry |

### Spot Trading

| Command | Purpose |
|---------|---------|
| `dflow quote <amount> <from> [to]` | Get spot quote (default 50 bps slippage) |
| `dflow trade <amount> <from> [to]` | Execute spot swap |
| `dflow trade <amount> <from> [to] --confirm` | Execute with auto-confirm (no prompt) |
| `dflow trade --declarative <amount> <from> [to]` | Declarative execution (DFlow optimizes routing at execution time) |
| `dflow quote <amount> <from> [to] --slippage 100` | Custom slippage in basis points |

### Prediction Market Trading

| Command | Purpose |
|---------|---------|
| `dflow quote <amount> USDC --market <MARKET_MINT> --side yes` | Quote a prediction market buy |
| `dflow trade <amount> USDC --market <MARKET_MINT> --side yes` | Buy YES outcome tokens |
| `dflow trade <amount> CASH --market <MARKET_MINT> --side no` | Buy NO outcome tokens with CASH |
| `dflow trade <amount> <OUTCOME_MINT>` | Sell outcome tokens |
| `dflow status <signature\|order>` | Check trade execution status |

### Transfers & Funding

| Command | Purpose |
|---------|---------|
| `dflow send <amount> <token> <recipient>` | Native or SPL token transfer |
| `dflow fund <USDC\|SOL>` | Buy crypto via MoonPay (browser-based, human-only) |

### Guardrails (Safety Limits)

| Command | Purpose |
|---------|---------|
| `dflow guardrails show` | Display current limits (no password required) |
| `dflow guardrails set <key> [value]` | Set safety limit (requires password) |
| `dflow guardrails remove <key>` | Remove a specific guardrail |
| `dflow guardrails reset` | Clear all guardrails |

### Global Flags

| Flag | Purpose |
|------|---------|
| `--rpc-url <url>` | Override Solana RPC endpoint |
| `--wallet <name>` | Specify vault wallet name |

## Built-in Token Symbols

`SOL`, `USDC`, `USDT`, `CASH`, `BONK`, `JUP`, `WIF`, `PYTH`, `JTO`, `RAY`, `ORCA`, `MNDE`, `MSOL`, `JITOSOL`, `BSOL`, `RENDER`.

All other assets require base58 mint addresses.

## Output Format

Every command returns structured JSON. Agents should parse the `ok` field to determine success or failure.

### Success

```json
{ "ok": true, "data": { ... } }
```

### Error

```json
{
  "ok": false,
  "error": "Human-readable message",
  "error_code": "MACHINE_CODE",
  "category": "routing",
  "recoverable": true,
  "suggestion": "Actionable next step."
}
```

Key fields:
- `error_code` — machine-parseable constant for programmatic handling
- `category` — error domain classification
- `recoverable` — whether retrying makes sense
- `suggestion` — actionable guidance for the agent

**Exception**: `dflow whoami` outputs only the raw pubkey string on success, not the JSON envelope.

## Key Management — Open Wallet Standard (OWS)

The CLI implements the Open Wallet Standard for secure key management. Private keys are encrypted in a local vault and never exposed to the agent.

### Storage Layout (`~/.ows/`)

| Path | Purpose |
|------|---------|
| `~/.ows/wallets/<uuid>.json` | Encrypted wallet keypairs |
| `~/.ows/guardrails.json` | HMAC-signed guardrail configuration |
| `~/.ows/trade_history.json` | Trade history log |
| `~/.ows/logs/audit.jsonl` | Append-only audit log (signing + wallet lifecycle) |

### Password Resolution Order

1. OS keychain (macOS Keychain / Linux secret service) if saved during setup
2. `DFLOW_PASSPHRASE` environment variable (read once, cleared from memory)
3. Interactive terminal prompt

### Security

- Keys encrypted with KDF-derived decryption key (brute-force resistant)
- Directories set to `700`, wallet files to `600`
- Commands fail with `VAULT_INSECURE` if permissions are too open
- Non-custodial — private keys never leave the local machine
- Multiple independently encrypted wallets supported

## Guardrails — Agent Safety Limits

Guardrails are client-side safety limits stored in `~/.ows/guardrails.json` and HMAC-signed to prevent agent tampering. Humans define risk boundaries; agents execute within them.

| Key | Function |
|-----|----------|
| `max_trade_size_usd` | Cap single trade USD value |
| `max_daily_volume_usd` | Cap 24-hour rolling volume |
| `max_wallet_value_usd` | Cap total wallet USD value |
| `allowed_tokens` | Whitelist of buyable mints (sells unrestricted) |
| `rate_limit` | Max trades within a time window |
| `sweep_address` | Public key for excess fund sweeps |

```bash
# Set guardrails (requires vault password)
dflow guardrails set max_trade_size_usd 5000000
dflow guardrails set max_daily_volume_usd 50000000
dflow guardrails set allowed_tokens SOL,USDC,BONK

# Read guardrails (no password required — agents can check their own limits)
dflow guardrails show
```

Design:
- `show` does NOT require the vault password (read-only)
- `set` DOES require the vault password (write operation)
- HMAC signing prevents agents from silently modifying guardrails
- Guardrails enforced locally before any trade is submitted

## Agent Attribution

The CLI auto-detects the calling environment and sets HTTP headers for observability:

| Header | Values | Purpose |
|--------|--------|---------|
| `X-Dflow-Caller` | `human`, `agent`, `unknown` | Identifies caller type |
| `X-Dflow-Agent` | `cursor`, `clawd-code`, `clawd`, `github-actions`, `ci`, custom | Detected agent tool |
| `X-Dflow-Model` | e.g. `clawd-code`, `gpt-4o` | Registered via `dflow agent --model` |

Override detection with environment variable: `DFLOW_AGENT=my-bot dflow trade 500000 USDC SOL`

## Error Handling

| Error Code | Meaning | Action |
|------------|---------|--------|
| `VAULT_INSECURE` | File permissions too open | `chmod 700 ~/.ows && chmod 600 ~/.ows/wallets/*.json` |
| `NOT_CONFIGURED` | Setup not complete | Run `dflow setup` |
| `PROOF_NOT_VERIFIED` | KYC required for prediction markets | Complete verification at provided URL |
| `GEOBLOCKED` | Region restricted (prediction markets) | Spot trading still works |
| `route_not_found` | No route for trade | Check amount units (atomic), verify mints, check liquidity |
| `price_impact_too_high` | Trade too large for liquidity | Reduce amount or split into smaller trades |

## Resources

- Agent CLI Docs: `https://pond.dflow.net/build/agent-cli`
- DFlow API Key: `https://pond.dflow.net/build/api-key`
- DFlow Cookbook: `github.com/DFlowProtocol/cookbook`
- DFlow Skill File: `pond.dflow.net/skill.md`
- DFlow MCP Server: `pond.dflow.net/mcp`
