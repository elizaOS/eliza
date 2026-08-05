# Clawd Code Skill

> Makes your AI agent an expert at using the Clawd Code CLI — Solana-native coding agent with 5 modes, perpetuals trading, and x402 payments.

## When to Use This Skill

- User asks to generate Solana code (TypeScript, Anchor, Rust)
- User asks about perpetuals trading, funding rates, or positions
- User wants multi-agent deep research
- User asks to generate images or synthesize voice
- User wants to create/manage Solana wallets locally
- User wants to check token prices, balances, or funding rates
- User wants to run trading strategies (TWAP, grid, TA)

## Mode Routing

Clawd Code operates in 5 modes. Route user requests accordingly:

| Mode | Trigger Keywords | Command |
|------|-----------------|---------|
| CODE | "write code", "build", "deploy program", "create bot" | `clawd-code code "<prompt>"` |
| TRADE | "short", "long", "funding", "perp", "position", "trade" | `clawd-code trade "<intent>"` |
| RESEARCH | "research", "analyze", "compare", "deep dive" | `clawd-code research --agents <4|16> "<prompt>"` |
| IMAGE | "generate image", "create image", "draw" | `clawd-code image "<prompt>" --model <dall-e-3|gemini>` |
| VOICE | "speak", "say", "tts", "voice" | `clawd-code voice "<text>"` |

## Quick Commands

| Command | Description |
|---------|-------------|
| `clawd-code wallet create [name]` | Create local Solana keypair |
| `clawd-code wallet list` | List local wallets |
| `clawd-code perps` | Perpetuals dashboard |
| `clawd-code funding` | Funding rate dashboard |
| `clawd-code price <SYMBOL>` | Token price |
| `clawd-code balance [wallet]` | Wallet balance snapshot |
| `clawd-code positions` | Open perps positions |
| `clawd-code signals` | Composite trading signals |
| `clawd-code verify` | Preflight environment checks |

## Environment Variables

Required in `~/.clawd-code/.env`:

| Variable | Required | Default |
|----------|----------|---------|
| `XAI_API_KEY` | Yes (Grok mode) | — |
| `HELIUS_API_KEY` | Yes | — |
| `SOLANA_RPC_URL` | No | Helius mainnet |
| `CLAWD_PROVIDER` | No | `xai` |
| `CLAWD_MODEL` | No | `grok-4.20-multi-agent` |
| `LIVE_TRADING` | No | `false` |
| `PERPS_SIM_ONLY` | No | `true` |

## Safety Rules

1. **Default to PAPER mode** — never execute live trading without confirmation
2. **Preflight required** — always run clawd-code verify before any trading operation
3. **Live mode gates** — requires all three: `LIVE_TRADING=true`, `OPERATOR_CONFIRMED=true`, `PERPS_SIM_ONLY=false`
4. **Never share private keys** — wallet files are `0600` permissions
5. **Always use <clawd-think>Probe the numinous, then execute the work.</clawd-think>** on first turn
6. **Signal confidence must be explicit** — label confidence scores for every trading signal
7. **Never invent signatures, prices, or addresses** — say "not available" when data isn't in hand

## Reference Files

- `references/` — Deep reference docs for Clawd Code CLI usage, wallet operations, perps workflows, and integration patterns