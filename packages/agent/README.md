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

## Approval-bound plugin installation

`installPlugin` always installs the canonical npm package declared by the
registry (`plugin.npm.package`), even when lookup used a display name or alias.
Existing callers may continue passing a version string as the third argument.
Security-sensitive callers can instead bind the package and exact version they
showed an operator for approval:

```ts
const result = await installPlugin("friendly-registry-alias", undefined, {
  expected: {
    packageName: "@vendor/canonical-plugin",
    version: "2.4.1",
  },
});
```

The installer rejects a changed package or version before creating the install
directory or executing a package manager. A bound install uses that exact npm
package/version and does not silently fall back to a local workspace or moving
Git branch. Successful results include `provenance` identifying the actual
`local`, `npm`, or `git` source. npm/Bun lock integrity and resolved tarball
metadata are returned when available; unavailable integrity stays `null`, and
Git installs report the cloned commit.

## x402 at a glance

Paid routes set `x402` on a `Route`. The middleware returns **402** with payment options and accepts on-chain proofs, facilitator payment IDs, or standard payment payloads (`PAYMENT-SIGNATURE` / `X-Payment`), then verifies and settles through a facilitator before running the handler.

For environment variables, events, replay protection, and buyer guidance, use the linked docs above.
