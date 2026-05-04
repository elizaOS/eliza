# `@elizaos/agent`

Standalone elizaOS agent and HTTP backend. Plugin routes can be registered on `AgentRuntime` and are served by the agent’s HTTP stack.

## Documentation

- **Paid HTTP routes (webhooks, plugins):** see the docs site section on [webhooks and routes](https://docs.elizaos.ai/plugins/webhooks-and-routes).
- **x402 micropayments on plugin routes:** see [x402 paid plugin routes](https://docs.elizaos.ai/plugins/x402-paid-routes) and the [x402 roadmap](https://docs.elizaos.ai/plugins/x402-roadmap) for protocol alignment, env vars, and planned work.

**Why this README exists:** the published docs site is the canonical narrative for operators and plugin authors; this file is the short “where do I look?” entry point from the package root and from npm/GitHub directory views.

## Local development

From this package:

```bash
bun install
bun run typecheck
bun run test
```

See `package.json` for `build`, `lint`, and other scripts.

## x402 at a glance

Paid routes set `x402` on a `Route`. The middleware can:

- Return **402** with payment options (legacy JSON body for x402scan-style clients **and** `PAYMENT-REQUIRED` for standard buyers).
- Accept **on-chain proofs**, **facilitator payment IDs**, or **standard payment payloads** (`PAYMENT-SIGNATURE` / `X-Payment`), then **verify and settle** through a facilitator before running the handler.

**Why verify *and* settle:** a valid authorization signature is not the same as collected funds. Unlocking the handler only after settlement matches how facilitators are meant to be used and avoids “free API” gaps between verify and on-chain execution.

For environment variables, events, replay protection, and buyer guidance, use the linked docs above.
