# @elizaos/contracts

Shared browser-safe domain DTOs, constants and input validation used by plugins,
hosts and renderers. Import the public barrel; internal files import definitions
directly. Storage, authorization, identity merging and effects remain with their
runtime or domain owners.

From the repository root, run `bun run --cwd packages/contracts build` and
`bun run --cwd packages/contracts typecheck`. Run contract regressions with
`bun run --cwd packages/contracts test`; integration regressions remain in their
domain owners.

Use `@elizaos/contracts` for browser-safe DTOs and validators. Node signing and verification contracts use `@elizaos/contracts/node`. Persisted backup versions and canonical bytes remain supported.
