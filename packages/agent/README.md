# `@elizaos/agent`

Standalone elizaOS agent and HTTP backend. Plugin routes can be registered on `AgentRuntime` and are served by the agent’s HTTP stack.

## Documentation

- **Paid HTTP routes (webhooks, plugins):** see the docs site section on [webhooks and routes](https://docs.elizaos.ai/plugins/webhooks-and-routes).
- **x402 micropayments on plugin routes:** see [x402 paid plugin routes](https://docs.elizaos.ai/plugins/x402-paid-routes) for protocol alignment and env vars.

## Local development

From this package:

```bash
bun install
bun run typecheck
bun run test
```

See `package.json` for `build`, `lint`, and other scripts.

## x402 at a glance

Paid routes set `x402` on a `Route`. The middleware returns **402** with payment options and accepts on-chain proofs, facilitator payment IDs, or standard payment payloads (`PAYMENT-SIGNATURE` / `X-Payment`), then verifies and settles through a facilitator before running the handler.

For environment variables, events, replay protection, and buyer guidance, use the linked docs above.
