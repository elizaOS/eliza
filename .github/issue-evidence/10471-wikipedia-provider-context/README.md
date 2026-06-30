# Issue #10471 — Wikipedia Provider Context

Branch: `fix/10471-wikipedia-provider-context`

Base at validation: `origin/develop` `ebed3de42a9a1febffbe97cbf0526164aa0b0460`

## What changed

- Removed the `WIKIPEDIA_MUSIC` provider's English prose classifier for `introduce` / `recommend` / `related` style requests.
- The provider now passes a neutral `general_info` purpose plus the user request as `requestContext` for the LLM extraction prompt.
- The Wikipedia extraction service normalizes and caps request context before using it in prompts and cache keys, so prompt-dependent extractions are not reused across distinct requests for the same entity.

## Validation

- `bun install` completed after rebasing, including artifact sync to `2026-06-18.1`.
- `bun run --cwd plugins/plugin-suno build` passed before the full music test suite.
- `bun run --cwd plugins/plugin-music test src/providers/wikipediaProvider.test.ts src/services/wikipediaExtractionService.test.ts` passed: 2 tests.
- `bun run --cwd plugins/plugin-music test` passed: 42 tests across 9 files.
- `bun run --cwd plugins/plugin-music typecheck` passed.
- `bun run --cwd plugins/plugin-music lint:check` passed.
- `git diff --check` passed.
- `bun run verify` did not complete: the type-safety ratchet passed and then the workspace lint fanout failed on unrelated `@elizaos/cloud-shared` formatting/import-order drift in `src/db/repositories/__tests__/agent-billing-reactivation.test.ts` and `src/lib/services/eliza-sandbox.ts`; the command ended with exit code 139. Full log: `root-verify.log`.

## Evidence Rows

- Real LLM trajectory: N/A. This slice removes provider-side English keyword routing and is covered by deterministic provider/service tests. No supported model API key was present; see `model-key-presence.txt`.
- Backend logs: command logs attached in this directory.
- Frontend logs/screenshots/video: N/A, no UI or app route changed.
- Android/native/audio capture: N/A, no Android/native/audio surface changed.
- Domain artifacts: N/A, no DB/memory/files/chain state is produced by this provider refactor.
