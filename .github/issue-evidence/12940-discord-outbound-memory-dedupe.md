# #12940 Discord outbound message memory dedupe

Date: 2026-07-04
Base: `origin/develop` at `1a5c37bc02`
Branch: `fix/12940-discord-outbound-memory-dedupe`

## Scope

- `plugins/plugin-discord/messages.ts`
- `plugins/plugin-discord/service.ts`
- `plugins/plugin-discord/__tests__/messages-url.test.ts`

This slice addresses #12940 finding 10's suspected duplicate bot-message rows by
making Discord connector-side message-memory persistence idempotent. Discord
already derives response memory ids from the platform message id via
`createUniqueUuid(runtime, sentMessage.id)`. The new helper checks
`runtime.getMemoryById(memory.id)` before writing and skips connector-side
`createMemory` when core or another Discord send path already persisted that
deterministic id.

The guard is used for:

- normal Discord response callbacks,
- connector send/draft paths,
- existing inbound persistence, preserving its previous no-id no-op behavior.

## Validation

Commands run from a fresh sparse worktree based on current `origin/develop`:

```bash
bunx @biomejs/biome check \
  plugins/plugin-discord/messages.ts \
  plugins/plugin-discord/service.ts \
  plugins/plugin-discord/__tests__/messages-url.test.ts
```

Result: passed.

```bash
git diff --check
```

Result: passed.

Focused unit test added:

```text
plugins/plugin-discord/__tests__/messages-url.test.ts
  createDiscordMessageMemoryOnce
    - skips connector-side persistence when the deterministic memory id already exists
    - creates the message memory when no existing id is found
```

Sparse-worktree blockers:

- `bun run --cwd plugins/plugin-discord test -- __tests__/messages-url.test.ts`
  initially failed before loading tests because `discord.js` was absent from the
  sparse dependency graph.
- After installing external Discord/Vitest packages in a temporary dependency
  directory, the test then failed before loading tests because `@elizaos/core`
  package exports require a built core entry.
- Attempting `bun run --cwd packages/core build` in the sparse checkout reached
  unresolved transitive dependencies such as `@elizaos/prompts`, `handlebars`,
  `uuid`, `drizzle-orm`, and logger dependencies.
- `bun run --cwd plugins/plugin-discord typecheck` failed before TypeScript
  analysis because `tsgo` was absent from the sparse dependency graph.

No live Discord run was captured for this narrow persistence guard. The live
symptom in #12940 already identified duplicate bot rows with the same Discord
platform message identity; this PR adds the deterministic-id guard and focused
unit coverage for the duplicate-write path.
