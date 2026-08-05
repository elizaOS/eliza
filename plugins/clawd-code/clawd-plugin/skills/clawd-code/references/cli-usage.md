# Clawd Code CLI Usage

## Mode Reference

### CODE MODE
Generates TypeScript, Anchor, Rust Solana code.

```bash
clawd-code code "Build a Jupiter swap bot in TypeScript"
clawd-code code "Create an Anchor program for token staking"
```

### TRADE MODE
Perpetuals trading with Phoenix Rise + Vulcan MCP.

```bash
clawd-code trade "SOL funding rate?"
clawd-code trade "short SOL $100"
clawd-code trade "long ETH $50"
```

**Preflight checks (all required for live):**
- SOL in allowlist
- Notional ≤ cap
- Leverage ≤ max
- Spread ≤ max bps

**Execution modes:**
- PAPER (default) — simulated execution
- LIVE — requires `LIVE_TRADING=true`, `OPERATOR_CONFIRMED=true`, `PERPS_SIM_ONLY=false`

### RESEARCH MODE
Multi-agent deep research with grok-4.20-multi-agent.

```bash
clawd-code research --agents 4 "Solana perps funding arb"
clawd-code research --agents 16 "AI agent frameworks 2025"
```

### IMAGE MODE
Image generation via DALL-E or Gemini.

```bash
clawd-code image "cyberpunk Solana trading desk" --model dall-e-3
clawd-code image "neon clawd logo" --model gemini
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
| `clawd-code perps` | Perpetuals dashboard |
| `clawd-code funding` | Funding rate dashboard |
| `clawd-code price SYMBOL` | Token price via Birdeye |
| `clawd-code balance [wallet]` | Wallet balance snapshot |
| `clawd-code send TOKEN AMOUNT ADDRESS` | Send SOL or SPL tokens |
| `clawd-code positions` | Open perps positions |
| `clawd-code signals` | Composite trading signals |
| `clawd-code strategies` | Vulcan strategy runners |
| `clawd-code agents` | Clawd agent registry |
| `clawd-code models` | List available Grok models |
| `clawd-code provider` | Show/switch AI provider |
| `clawd-code goal <text>` | Natural language intent router |
| `clawd-code verify` | Preflight environment checks |

## Output Format

- Default: text (rich terminal output with box-drawing)
- JSONL: `--format json` for machine-parseable output

## Providers

| Provider | Key | Default Model |
|----------|-----|---------------|
| xai | `XAI_API_KEY` | grok-4.20-multi-agent |
| openrouter | `OPENROUTER_API_KEY` | nex-agi/nex-n2-pro:free |
| deepseek | `DEEPSEEK_API_KEY` | deepseek-v4-pro |

Switch: `clawd-code /provider <xai|openrouter|deepseek>`