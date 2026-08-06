# clawd-go Reference

Source: `/Users/8bit/clawd-code/clawd-agents/clawd-go`

`clawd-go` is a Go SDK wrapper around `solana-go` with default x402.wtf RPC and AI proxy endpoints. Use it for Go-based Solana tools, agents, wallet operations, and lightweight AI-assisted flows.

## Package Layout

| Path | Role |
|---|---|
| `clawd.go` | Main example/entrypoint |
| `pkg/client` | Client setup and shared configuration |
| `pkg/lookup` | Account and chain lookup helpers |
| `pkg/token` | Token helpers |
| `pkg/transfer` | SOL/SPL transfer helpers |
| `pkg/tx` | Transaction helpers |
| `pkg/wallet` | Wallet/keypair helpers |
| `pkg/x402` | Default x402.wtf RPC and LLM proxy helpers |

## Defaults

The x402 package exposes these default endpoints:

| Capability | Endpoint |
|---|---|
| Solana RPC | `https://x402.wtf/api/rpc` |
| Default chat | `https://x402.wtf/api/clawd` |
| Gemini | `https://x402.wtf/api/clawd/gemini` |
| OpenAI | `https://x402.wtf/api/clawd/openai` |
| Grok | `https://x402.wtf/api/clawd/grok` |
| DeepSeek | `https://x402.wtf/api/clawd/deepseek` |
| Vision | `https://x402.wtf/api/clawd/vision` |

## Environment

| Variable | Purpose |
|---|---|
| `HELIUS_RPC_URL` | Optional explicit RPC endpoint |
| `CLAWD_API_KEY` | Optional; the default free path uses x402.wtf |

## Implementation Guidance

- Use `context.Context` and explicit request timeouts for all network calls.
- Keep private keys out of source and logs.
- Prefer a dedicated wallet for agent execution.
- For production RPC, allow callers to override the x402 default with a Helius endpoint.
- For paid or metered AI calls, expose clear spend controls and user-visible resource names.
- If adding transaction submission, align with the Build skill: Sender endpoint, priority fee estimate, Jito tip where required, and explicit commitment level.

## Quick Validation

```bash
cd clawd-agents/clawd-go
go test ./...
go run clawd.go
```
