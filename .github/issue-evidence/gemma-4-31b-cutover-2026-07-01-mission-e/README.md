# Mission E — repo verification + registry drift (gemma-4-31b cutover branch)

Date: 2026-07-01 → 2026-07-02 (run window)
Branch: `feat/cerebras-gemma-4-31b-cutover` (worktree `/home/shaw/eliza-wt-gemma4`)
HEAD: `6c51e742ff` · merge-base with `origin/develop`: `b748049e68`
API key used only as env `$CEREBRAS_API_KEY` (never written to disk). No live calls were needed for this mission — all lanes below are keyless.

## Pass/fail table

| Lane | Command | Result |
| --- | --- | --- |
| verify (full chain) | `bun run verify` | FAIL at first gate — `audit:type-safety-ratchet` (PRE-EXISTING on develop, see below) |
| type-safety ratchet | `bun run audit:type-safety-ratchet` | FAIL — `as unknown as` 80 > 77 baseline, `?? {}` 379 > 377 baseline. **Pre-existing on develop**: branch diff adds 0 occurrences of either pattern; `git grep` counts identical at merge-base `b748049e68`, HEAD, and `origin/develop` head (`as unknown as` raw 97/97/97; `?? {}` in core/agent/app-core 420/420). Baseline file untouched by branch and unchanged on develop since before merge-base. Not fixed here per mission rules. |
| typecheck (all workspaces) | `node packages/scripts/run-turbo.mjs run typecheck --filter='!@elizaos/example-code'` | PASS (after worktree-install repair) — sole red was `@elizaos/ui` `TS2307: Cannot find module 'iwer'`; `iwer@2.2.1` was in package.json + bun.lock but absent from the worktree's bun store (install-state gap, not code). `bun install` restored it; `bun run --cwd packages/ui typecheck` then exits 0. |
| lint (all workspaces, --continue) | `node packages/scripts/run-turbo.mjs run lint --continue --filter='!@elizaos/example-code'` | FAIL — 6 packages, ALL PRE-EXISTING (9 failing files each byte-identical to origin/develop): agent (`src/api/accounts-routes.ts` unused import, `src/runtime/sandbox-character.ts` organize-imports), app-core (`src/api/auth.ts`, `src/services/coding-account-bridge.ts`), cloud-api (2 integration tests), cloud-shared (`app-charge-requests.ts`, `token-redemption-secure.ts`), plugin-scheduling (`runner.test.ts` format), ui (`BuyDomainCard.tsx`). Not fixed per mission rules. |
| app-core lint | (part of lint lane) | FAIL — 2 organize-imports errors: `packages/app-core/src/api/auth.ts:30` (sort exports), `packages/app-core/src/services/coding-account-bridge.ts:26` (sort imports). **Pre-existing**: both files byte-identical to `origin/develop` (`git diff origin/develop HEAD -- <files>` = empty); last touched by develop commits `9b91ee226d` / `c7c8a4c09b`, both ancestors of merge-base. Not fixed here per mission rules (branch must not reformat untouched files). |
| audit:build-model | `bun run audit:build-model` | PASS (exit 0) |
| audit:turbo-build-deps | `bun run audit:turbo-build-deps` | PASS (exit 0) |
| audit:tee-secret-leak | `bun run audit:tee-secret-leak` | PASS (exit 0) |
| audit:scripts | `bun run audit:scripts` | PASS (exit 0) |
| audit:test-realness | `bun run audit:test-realness` | PASS (exit 0) |
| typecheck:dist | `bun run typecheck:dist` | FAIL — PRE-EXISTING, two causes: (a) committed `tsconfig.dist-paths.json` is stale on develop itself (missing `@elizaos/capacitor-mlkit-text` + `@elizaos/plugin-pii-guard` aliases; the committed file is byte-identical to origin/develop and both plugins exist at merge-base); (b) with a regenerated config, the consumer pass fails in `packages/examples/code` (`narrow-terminal.test.ts` TS2307 `bun:test` + TS7006 — tsconfig has `"types": ["node"]`), a package unchanged by this branch and since rewritten on develop (#11043). Regenerated files were restored; nothing committed. |
| registry generate | `bun run --cwd packages/registry generate:first-party` | PASS — wrote 116 entries + 9 curated-app definitions, zero file diff (working tree clean after) |
| registry drift check | `bun run --cwd packages/registry generate:first-party --check` | PASS — "generated artifacts are up to date" (exit 0) |
| scenario-runner cerebras judge | `bunx vitest run --root packages/scenario-runner src/cerebras-judge.test.ts` | PASS — 25/25 |
| benchmarks lib | `bunx vitest run --root packages/benchmarks/lib` | PASS — 44/44 (4 files) |
| plugin-openai shape lanes | `bunx vitest run --root plugins/plugin-openai __tests__/cerebras-config.shape.test.ts __tests__/reasoning-effort.shape.test.ts __tests__/native-plumbing.shape.test.ts` | PASS — 43/43 (3 files) |
| plugin-training cerebras runner | `bunx vitest run --root plugins/plugin-training src/core/benchmark-vs-cerebras-runner.test.ts` | PASS — 4/4 |
| lifeops-bench model tiers (pytest) | `python3 -m pytest packages/benchmarks/lifeops-bench/tests/test_model_tiers.py` | PASS — 19/19 |
| smithers-adapter (pytest) | `python3 -m pytest packages/benchmarks/smithers-adapter/tests` | PASS — 24/24 (deps installed cleanly, nothing skipped) |

## Registry drift detail

`packages/registry/src/first-party/generated.json` after regeneration:

- `entries[elizacloud].config` — all four model defaults are `gemma-4-31b`:
  `ELIZAOS_CLOUD_SMALL_MODEL`, `SMALL_MODEL`, `ELIZAOS_CLOUD_LARGE_MODEL`, `LARGE_MODEL`.
- Only remaining `gpt-oss-120b` strings are `entries[groq].config.GROQ_SMALL_MODEL` /
  `GROQ_LARGE_MODEL` = `openai/gpt-oss-120b` — legitimate (groq does not serve gemma).
- Cerebras surface lives on the `openai` plugin entry as `CEREBRAS_API_KEY`
  ("Compatibility API key for Cerebras-hosted OpenAI-compatible requests",
  `autoEnableProvider: true`); no gpt-oss remnants in that entry.

## Pre-existing develop reds (recorded, NOT fixed on this branch)

1. `audit:type-safety-ratchet` — `as unknown as` 80 vs baseline 77; `?? {}` (core/agent/app-core) 379 vs 377.
   Proof it predates the branch: `git diff b748049e68..HEAD | grep '^+' | grep -c 'as unknown as'` → 0;
   same for `?? {}` → 0; raw `git grep` counts identical across merge-base / HEAD / origin/develop.
2. Six lint-red packages (agent, app-core, cloud-api, cloud-shared, plugin-scheduling, ui) —
   9 failing files, every one byte-identical to origin/develop.
3. `typecheck:dist` — stale `tsconfig.dist-paths.json` on develop + `packages/examples/code`
   `bun:test` type errors (package unchanged by branch).

Because the ratchet is verify's first gate and the lint reds sit mid-chain, `bun run verify`
cannot go green on ANY branch cut from this develop state without out-of-scope fixes; every other
stage of the chain was executed individually and passes as tabulated above.

## Fix made on this branch

- `plugins/plugin-openai/__tests__/cerebras-spawn-subagent-refusal.live.test.ts` — biome format fix
  (the `CEREBRAS_REFUSAL_MODELS` array collapsed to one line). This file IS touched by the branch and
  its committed form was not biome-clean; plugin-openai's `lint` script is `biome check --write --unsafe .`,
  which would otherwise dirty the tree on every lint run.

## Hazard note for future verify runs in this repo

Many workspace `lint` scripts are `biome check --write --unsafe .` — running turbo `lint` MUTATES the
working tree. This run reformatted 13 files in packages this branch never touched (pii-swap-reply-egress,
rollback-frontend, subscription-limit, discord debouncer, elizacloud tts/voice-catalog tests, health
scenarios, local-inference voice tests, agent-orchestrator fixtures) — all reverted via `git checkout --`.
Additionally, `bun install`'s postinstall artifact-sync rewrote both `appIcon.png` assets (39 KB → 425 KB,
reverted) and registered a stray untracked `plugins/plugin-remote-ledger/` dir into `bun.lock` (reverted;
the stray dir was left in place, untracked). The registry generator also normalizes
`plugins/plugin-pii-guard/registry-entry.json` indentation as a side effect (reverted; `--check` still
passes with the committed form).
