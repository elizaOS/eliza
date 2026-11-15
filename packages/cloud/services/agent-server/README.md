# @elizaos/agent-server

The cloud **agent-server**: an Elysia HTTP service that hosts live Eliza agent runtimes inside a pod.

Lifecycle mutations serialize per agent. Starting and stopping runtimes do not
accept work; failed cleanup retains ownership for retry. Routing publication
and retirement serialize separately. See the bounded [protocol models](../../quint/README.md).

Install workspace dependencies with `bun install` at the repository root.

No separate build script; this workspace runs from source.

Validate from the repository root:

```bash
bun run --cwd packages/cloud/services/agent-server typecheck  # static validation
bun test packages/cloud/services/agent-server/src/agent-lifecycle.test.ts
AGENT_ROUTING_REDIS_TEST_URL=redis://127.0.0.1:6379 bun test packages/cloud/services/agent-server/src/agent-routing.integration.test.ts
```

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
