# Clawd Grok Reference

Source: `/Users/8bit/clawd-code/clawd-agents/clawd-grok`

Clawd Grok is a terminal-native Clawd Code harness with provider routing, persistent sessions, sub-agents, Telegram remote control, MCP tools, local payments, Solana/Phoenix workflows, and optional toolsets.

## Core Commands

| Command | Purpose |
|---|---|
| `clawd` | Interactive TUI |
| `clawd -p "<prompt>"` | One-shot headless run |
| `clawd --provider zai --model glm-5.2 -p "<prompt>"` | Run through a selected provider/model |
| `clawd --model openrouter:auto -p "<prompt>"` | Route through OpenRouter |
| `clawd --session latest` | Continue saved session |
| `clawd --format json -p "<prompt>"` | JSON output for scripts/agents |
| `clawd telegram-bridge` | Telegram bridge |

## Provider Resolution

Provider selection resolves in this order:

1. Explicit model prefix, such as `openrouter:auto` or `zai:glm-5.2`.
2. `--provider <id>`.
3. `CLAWD_PROVIDER`, `AI_PROVIDER`, or saved `~/.clawd/user-settings.json`.
4. Model metadata.
5. xAI as the default provider.

Supported provider IDs include `xai`, `zai`, `openai`, `openrouter`, `deepseek`, and `custom`.

## Important Source Areas

| Path | Purpose |
|---|---|
| `src/grok/models.ts` | Provider/model metadata and aliases |
| `src/grok/client.ts` | Native xAI and OpenAI-compatible provider factory |
| `src/grok/tools.ts` | Tool registry, sub-agent delegation, optional toolsets, x402 payment tools |
| `src/utils/settings.ts` | Env and user settings resolution |
| `src/mcp` | MCP catalog/runtime/validation |
| `src/payments` | x402 payment history, paid requests, and security checks |
| `src/telegram` | Telegram relay and bridge behavior |
| `src/verify` | Verification orchestration and recipes |

## Optional Toolsets

The `camsnap` toolset adds camera discovery, still capture, clips, watch, and diagnostics. Enable with:

```bash
clawd --toolset camsnap
CLAWD_TOOLSETS=camsnap clawd
```

## Safety

- Native xAI-only capabilities such as web/X search, image/video generation, and batch mode require the xAI provider.
- Other chat, code, file, shell, MCP, sub-agent, and Solana tools can run through OpenAI-compatible providers if the model supports tool calls.
- Trading commands should start in paper or dry-run mode.
- Treat local wallet files, x402 payment logs, and provider keys as sensitive.
- When extending payment tools, keep user approval and max-spend checks in the foreground.

## Development

```bash
cd clawd-agents/clawd-grok
bun install
bun run build
bun test
bun run dev -- --provider zai --model glm-5.2
```
