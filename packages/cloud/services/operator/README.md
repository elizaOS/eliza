# @elizaos/operator

A [Pepr](https://pepr.dev) Kubernetes operator that manages `Server` (`servers.eliza.ai`, `v1alpha1`) custom resources in the `eliza-agents` namespace.

Status writes and finalization serialize per Server. Route cleanup checks the
current owner before deletion. See the bounded [protocol models](../../quint/README.md).

Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd packages/cloud/services/operator build
```

Validate from the repository root:

```bash
bun run --cwd packages/cloud/services/operator typecheck  # static validation
OPERATOR_REDIS_TEST_URL=redis://127.0.0.1:6379 bun test packages/cloud/services/operator/capabilities/__tests__/routing-state.integration.test.ts
```

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
