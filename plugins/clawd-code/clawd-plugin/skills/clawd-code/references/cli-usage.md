# Clawd Code CLI Usage

## Mode Reference

### CODE MODE
Generates TypeScript, Anchor, Rust Solana code.

```bash
clawd-code code "Build a Jupiter swap bot in TypeScript"
clawd-code code "Create an Anchor program for token staking"
```

### TRADE MODE
Perpetuals trading with Imperial routing, Phoenix as the preferred default
venue, and Vulcan/Phoenix fallback workflows.

```bash
clawd-code trade "SOL funding rate?"
clawd-code trade "short SOL $100"
clawd-code trade "long ETH $50"
clawd-code imperial status
clawd-code imperial register imperial --profile 0 --write-env
clawd-code imperial auth imperial --write-env
clawd-code imperial auth imperial --arm-live
clawd-code imperial positions
clawd-code imperial revoke
```

**Preflight checks (all required for live):**
- SOL in allowlist
- Notional ≤ cap
- Leverage ≤ max
- Spread ≤ max bps

**Execution modes:**
- PAPER (default) — simulated execution
- LIVE — requires `LIVE_TRADING=true`, `OPERATOR_CONFIRMED=true`, `PERPS_SIM_ONLY=false`
- IMPERIAL LIVE — also requires `IMPERIAL_LIVE=true`, `IMPERIAL_WALLET`, `IMPERIAL_JWT`, and `IMPERIAL_PROFILE_INDEX`

`IMPERIAL_JWT` is delegated trading access for the configured wallet/profile.
Never print or commit it.
`imperial register <wallet-name> --profile 0 --write-env` activates the Phoenix
profile for a new local wallet through Imperial's unauthenticated registration
endpoint and persists wallet/profile settings.
`imperial auth <wallet-name>` signs the Imperial mobile-connect message with the
local wallet file and exchanges the one-time code for a JWT. `--write-env`
persists the masked session settings; `--arm-live` persists the live gates too.

### RESEARCH MODE
Multi-agent deep research with the configured provider. The default provider is
Z.AI GLM-5.2; OpenRouter can route through Nemo or explicit Fable aliases.

```bash
clawd-code research --agents 4 "Solana perps funding arb"
clawd-code research --agents 16 "AI agent frameworks 2025"
```

### IMAGE MODE
Image generation via Z.AI GLM-Image by default.

```bash
clawd-code image "cyberpunk Solana trading desk"
clawd-code image "neon clawd logo" --model glm-image
```

### VOICE MODE
Text-to-speech via sherpa-onnx or ElevenLabs.

```bash
clawd-code voice "Clawd Code is operational"
```

## Solana CLI Commands

| Command | Description |
|---------|-------------|
| `clawd-code wallet create [name]` | Create local Solana keypair |
| `clawd-code wallet list` | List local wallet public keys |
| `clawd-code chain status` | Show Solana RPC harness status |
| `clawd-code chain balance [wallet]` | Wallet balance snapshot |
| `clawd-code chain account ADDRESS` | Inspect an account |
| `clawd-code perps` | Perpetuals dashboard |
| `clawd-code funding` | Funding rate dashboard |
| `clawd-code trade "<intent>"` | Trade/funding/position workflow |
| `clawd-code imperial status` | Imperial router readiness/profile status |
| `clawd-code imperial register <wallet> --profile 0 --write-env` | Activate and persist a Phoenix profile through Imperial |
| `clawd-code imperial auth <wallet> --write-env` | Persist Imperial mobile JWT settings |
| `clawd-code research "<prompt>"` | Research mode |
| `clawd-code image "<prompt>"` | Image mode |
| `clawd-code repl` | Interactive model/provider session |
| `clawd-code models` | List available models |
| `clawd-code provider` | Show/switch AI provider |
| `clawd-code goal <text>` | Natural language intent router |
| `clawd-code verify` | Preflight environment checks |
| `clawd-code telegram` | Start the Telegram relay — routes an allowlisted chat's messages through Z.AI (chat/CLI only, no computer-use). Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHAT_ID`. |

## Output Format

- Default: text (rich terminal output with box-drawing)
- JSONL: `--format json` for machine-parseable output

## Providers

| Provider | Key | Default Model |
|----------|-----|---------------|
| zai | `ZAI_API_KEY` | glm-5.2 |
| xai | `XAI_API_KEY` | grok-4.3 |
| anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-6 |
| openrouter | `OPENROUTER_API_KEY` | auto Nemo routing, fable5, fable-latest |
| deepseek | `DEEPSEEK_API_KEY` | deepseek-v4-pro |

Switch: `clawd-code /provider <zai|xai|anthropic|openrouter|deepseek>`
