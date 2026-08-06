---
name: clawd-agents
description: Build, package, run, and monetize Clawd agent surfaces from the clawd-agents packages. Covers CLAWD agent product registration and SSO, clawd-go, Clawd Grok, Solana x402 gateways, A2A/MCP paid agent calls, and pump.fun/PumpSwap bot operations.
metadata:
  version: "1.0.0"
  source: "/Users/8bit/clawd-code/clawd-agents"
---

# Clawd Agents

Use this skill when the user wants to turn the local `clawd-agents` packages into a usable agent product, SDK integration, paid-agent gateway, or trading bot workflow.

## Source Packages

| Package | Route |
|---|---|
| `clawd-agent-product` | Agent registration JSON, MPL Core asset metadata, mint/register scripts, and CLAWD SSO verifier |
| `clawd-go` | Go SDK wrapper for Solana RPC, wallet/token/transfer helpers, and x402.wtf AI/RPC proxy defaults |
| `clawd-grok` | Terminal-native agent harness with provider routing, sessions, sub-agents, Telegram bridge, MCP, payments, and trading tools |
| `clawd-x402` | Solana x402 gateway, facilitator, paid A2A/MCP proxying, client SDK, registry/vault code, and revenue splits |
| `clawd-pump` | Reserved local package path; currently empty in this checkout |
| `clawdbot-pumpfun` | Rust PumpFun/PumpSwap copy-trading, autobuy, token tracking, notifications, and risk management |

## Routing

Identify the requested surface, then read the matching reference before implementing.

| User intent | Read first |
|---|---|
| Package a CLAWD identity/auth product, mint an agent asset, or run token-gated SSO | `references/agent-product.md` and `../agent-arena/SKILL.md` |
| Build a Solana agent or tool in Go | `references/clawd-go.md` |
| Run or extend the terminal agent harness, provider routing, sub-agents, Telegram, MCP, or payments | `references/clawd-grok.md` and `../clawd-code/SKILL.md` |
| Add pay-per-call access, x402 facilitator endpoints, A2A/MCP paid calls, holder discounts, or revenue splits | `references/x402.md` and `../agent-arena/SKILL.md` |
| Configure copy trading, PumpFun/PumpSwap parsing, autobuy, token tracking, Telegram notifications, or bot risk limits | `references/pumpfun-bot.md` plus `../build/references/sender.md` and `../build/references/priority-fees.md` |
| Build a combined paid trading agent | `references/agent-product.md`, `references/x402.md`, `references/pumpfun-bot.md`, then `../dflow/SKILL.md` or `../jupiter/SKILL.md` if swaps route through an aggregator |

## Implementation Rules

- Keep the plugin as instructions and references. Do not copy full source trees from `clawd-agents` into `clawd-plugin`.
- Preserve Solana-native identity and settlement. Do not add EVM rails unless the user explicitly asks for cross-chain interoperability.
- Never commit private keys, wallet secret arrays, bearer tokens, Telegram tokens, API keys, or Imperial JWTs. Use `.env` examples and secret managers.
- Default trading and bot workflows to simulation, dry-run, or paper mode until the user explicitly arms live execution.
- For transaction sending, use Helius Sender, priority fees, and explicit slippage/risk limits. Read the Build skill references before writing transaction code.
- For paid calls, expose maximum spend and allowed assets in client code. Block or ask before signing any payment whose resource, mint, destination, amount, decimals, or batch shape does not match the challenge.
- For agent registration, store `assetAddress`, `globalId`, registration URLs, and mint signatures permanently in config or secure state after successful mint/register flows.
- For SSO, verify wallet signature, required `$CLAWD` balance, submitted agent asset ownership, and registered AgentIdentity before issuing a session token.
- For pump.fun/PumpSwap bots, require explicit target wallets, trade caps, slippage caps, counter limits, and kill-switch behavior before live runs.

## Common Builds

### CLAWD-gated agent product

1. Read `references/agent-product.md`.
2. Read `../agent-arena/SKILL.md` for Metaplex Core agent registration and discovery.
3. Upload registration/metadata JSON.
4. Mint/register the agent asset with a dedicated funded Solana keypair.
5. Run the SSO verifier behind the paid gateway if tool execution should require settlement.
6. Return the asset address, `svm://solana-mainnet/<asset>`, profile URL, and SSO endpoint.

### Paid A2A or MCP agent endpoint

1. Read `references/x402.md`.
2. Resolve the agent endpoint and pricing from the registry or explicit config.
3. Return a machine-readable `402 Payment Required` challenge.
4. Verify and settle the Solana transfer before forwarding the request.
5. Strip payment credentials and hop-by-hop headers before proxying upstream.
6. Return a receipt header and persist a settlement receipt.

### PumpFun/PumpSwap operator bot

1. Read `references/pumpfun-bot.md`.
2. Confirm gRPC endpoint, token, monitored wallets, wallet funding, trade caps, slippage, and notification settings.
3. Start in monitor-only or dry-run mode.
4. Validate transaction parsing and token tracking with `--check-tokens`.
5. Enable live copy trading only after the user confirms the configured caps.

## Reference Files

- `references/agent-product.md` - CLAWD agent product, registration package, SSO verifier, and env contract.
- `references/clawd-go.md` - Go SDK wrapper layout, x402 proxy endpoints, and SDK implementation guidance.
- `references/clawd-grok.md` - Clawd Grok runtime, provider/model routing, toolsets, command map, and safety posture.
- `references/x402.md` - Solana x402 gateway flow, facilitator/client/vault parts, security invariants, environment, and verification.
- `references/pumpfun-bot.md` - PumpFun/PumpSwap copy-trading bot setup, commands, autobuy, token tracking, and risk management.
