# @elizaos/agent-server

The cloud **agent-server**: an Elysia HTTP service that hosts live Eliza agent runtimes inside a pod.


Install workspace dependencies with `bun install` at the repository root.

No separate build script; this workspace runs from source.

Validate from the repository root:

```bash
bun run --cwd packages/cloud/services/agent-server typecheck  # static validation
```

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
