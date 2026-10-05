# @elizaos/operator

A [Pepr](https://pepr.dev) Kubernetes operator that manages `Server` (`servers.eliza.ai`, `v1alpha1`) custom resources in the `eliza-agents` namespace.


Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd packages/cloud/services/operator build
```

Validate from the repository root:

```bash
bun run --cwd packages/cloud/services/operator typecheck  # static validation
```

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
