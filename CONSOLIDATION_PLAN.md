# Cross-Language Scaffolding Consolidation

**Status: COMPLETED** — 2026-05-08

## Phase Results

- **Phase 1 (proto removal):** `packages/schemas/` removed; `.proto` files, `buf.yaml`, `buf.gen.yaml`, `@bufbuild/*` dependencies, and `packages/core/src/types/generated/` all deleted. Types inlined as plain TypeScript under `packages/core/src/types/`.
- **Phase 2 (prompt consolidation):** `packages/prompts/prompts/*.txt` source files removed; templates now authored as TypeScript modules under `packages/prompts/src/`. Root scripts `generate:types`, `build:prompts`, and `generate-plugin-prompts` removed from `package.json`. `turbo.json` `@elizaos/schemas#build` task removed. `.gitignore` `packages/core/src/types/generated/` line removed.
- **Phase 3 (orphan sweep):** Knip run against `packages/core` flagged `src/features/advanced-capabilities/experience/generated/prompts/typescript/prompts.ts` as a leftover from the removed `prompts/*.txt` codegen pipeline; removed the `experience/generated/prompts/` subtree. Sibling `experience/generated/specs/` retained — still referenced by `experienceProvider.ts`.

## Verification

- `grep` across `CLAUDE.md`, `AGENTS.md`, `README.md`, `packages/*/README.md`, `plugins/*/README.md`, and `packages/docs/` for `buf generate`, `@bufbuild`, `.proto`, `build:prompts`, `generate:types`, `generate-plugin-prompts` returns no hits in the active source tree.
- `bun x tsc --noEmit -p packages/core` matches the pre-existing baseline (residual errors are in `packages/agent` and `packages/app-core`, unrelated to this consolidation).
- `packages/prompts/README.md` describes the TypeScript-first authoring layout.

## Known Remaining References

- `packages/docs/docs/launchdocs/17-prompt-optimization.md` is a dated launch-readiness assessment that references the historical `packages/prompts/prompts/*.txt` files in its findings narrative. Treated as a frozen audit artifact (same policy as `MOCK_AUDIT.md`-style docs) and left intact.
- `packages/benchmarks/framework/{README,PLAN}.md` mentions Rust protobuf-backed benchmark types — that refers to internal Rust binding behavior, unrelated to the removed cross-language scaffolding.
- `.claude/worktrees/agent-*/packages/schemas/...` still contain `.proto` files and `buf.yaml` configs — those belong to other agent worktrees and are out of scope per the worktree-isolation rule in `AGENTS.md`.
