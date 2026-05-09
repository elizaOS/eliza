# Consolidation Audit (Wave 4 / D1)

Audit of the protobuf + .txt-prompts consolidation (commit `b6a6aca782` "kill protobuf + .txt prompts" + `a48f8e1e6e` lint/workflow merge). Methodology: 12 verification checks against `packages/`, `plugins/`, `cloud/`, `.github/`, `docs/`. Excluded: `node_modules/`, `dist/`, `.claude/worktrees/*`.

## Results

### 1. `.txt` prompts under `*/prompts/*.txt` — ⚠️ false positives only
Survivors are all under `packages/benchmarks/`:
- `packages/benchmarks/solana/solana-gym-env/voyager/prompts/*.txt` (2 files)
- `packages/benchmarks/OSWorld/mm_agents/maestro/prompts/**/*.txt` (~18 files)

These belong to vendored third-party benchmark harnesses (Voyager, OSWorld), not elizaOS. **Out of scope** for this consolidation — they aren't sourced by `packages/prompts/`. Safe to leave.

### 2. Protobuf surface — ✅ clean
- No `*.proto` files anywhere under `packages|plugins|cloud`.
- No `@bufbuild/*` imports outside `node_modules`/`dist`/`trustedDependencies` allowlist.
- No `buf.yaml` / `buf.gen.yaml` / `buf.lock` / `@elizaos/schemas` / `packages/schemas` references.

### 3. `Proto*` identifiers / `from "./proto.js"` — ⚠️ leak (cosmetic)
- All `from "./proto.js"` matches in `packages/core/src` are inside a vendored bundle: `packages/app-core/platforms/electrobun/build/dev-macos-arm64/elizaOS-dev.app/Contents/Resources/app/eliza-dist/node_modules/@elizaos/core/src/types/*.ts`. That's a pre-built Electrobun snapshot — not live source. Stale artifact; safe but should be regenerated/excluded.
- `packages/core/src/types/database.ts` lines 1484, 1509, 1533 still define internal `interface ProtoMemoryRetrievalOptions / ProtoMemorySearchOptions / ProtoMultiRoomMemoryOptions`. These are vestigial naming from the old `proto.ts` era — they're plain TS interfaces ("Base shape for ... options" per their comments), not protobuf. Compile-clean but the prefix is now misleading.

### 4. `build:prompts` scripts — ✅ clean
No `package.json` under `packages/*` or `plugins/*` defines `build:prompts`.

### 5. `generate-plugin-prompts.js` / `packages/prompts/scripts/generate.js` references — ✅ clean
Not referenced anywhere. The `packages/prompts/scripts/` dir now contains only `check-secrets.js`, `generate-action-docs.js`, `generate-plugin-action-spec.js`, `prompt-compression.js`.

### 6. Stale `generated/prompts/` dirs — ⚠️ leak
Empty/dist-only survivors:
- `plugins/plugin-farcaster/generated/prompts/typescript/` — empty dir
- `plugins/plugin-discord/generated/prompts/typescript/` — empty dir
- `packages/core/dist/features/advanced-capabilities/experience/generated/prompts/typescript/` — `prompts.d.ts` + `.d.ts.map` (stale dist; will rebuild on next `bun run build`)
- `plugins/plugin-mcp/dist/node/generated/prompts/` — same: stale dist artifact

No source `.ts` files inside these. The plugin source dirs at `plugins/plugin-farcaster/generated/specs/` and `plugins/plugin-discord/generated/specs/` are still active (`spec-helpers.ts`, `specs.ts`) — those are unrelated to prompt consolidation.

### 7. `.bufrc` / `buf.*.yaml` / `buf.lock` / `.bufgenmissing` — ✅ clean
None found in `packages|plugins`.

### 8. `.github` workflows — ✅ clean
No `bunx buf` / `buf generate` / `buf lint` / `generate:types` / `generate-plugin-prompts` references anywhere under `.github/`.

### 9. Top-level plugin `prompts/` dirs — ⚠️ surviving (different system)
~17 plugin `prompts/` dirs survive at root level (`plugins/plugin-anthropic/prompts/`, `plugins/plugin-discord/prompts/`, etc.). Each contains 1-3 `.json` files (`actions.json`, `evaluators.json`, `providers.json`) — **not** `.txt` prompts. These are the action/evaluator/provider spec JSON files (separate system from the killed `.txt` prompts). Source `.ts` survivors:
- `plugins/plugin-music/src/prompts/musicPlayerInstructions.ts`
- `plugins/plugin-workflow/src/prompts/*.ts` (9 files: `actionResponse.ts`, `draftIntent.ts`, etc.)

Empty: `plugins/plugin-music-library/src/prompts/` — orphan dir, candidate for deletion.

The benchmark/voyager/OSWorld and `packages/prompts/` itself are out of scope.

### 10. Imports of `generated/prompts/typescript/prompts` — ✅ clean
No source `.ts` file outside `node_modules`/`dist` imports the deleted path.

### 11. `@elizaos/prompts` re-export wiring — ✅ clean
`packages/core/src/prompts.ts` is a 5-line `export * from "@elizaos/prompts"` re-export pointing at the hand-written source. Not the stale 1298-line dist copy.

### 12. `packages/core` e2e smoke — ❌ unverified (preflight failure)
`bun run --cwd packages/core test:e2e` with the supplied Cerebras key returns `Provider preflight failed. Skipping E2E tests. Unauthorized` and reports `9 skipped`. The OpenAI client logs `401 Unauthorized` against the supplied `OPENAI_API_KEY=csk-...`. Tests aren't running, so we cannot confirm 9/9 pass. **Not a consolidation regression** — auth gate; needs a fresh key from D2.

---

## Follow-ups

### Must-fix
1. **Delete empty `plugins/plugin-{farcaster,discord}/generated/prompts/typescript/` dirs.** Stale leftovers; will confuse new readers and may trip future glob-based generators.
2. **Re-run the smoke test with a working Cerebras key** to confirm the 9/9 baseline. Current run can't certify behavior.

### Should-fix
3. **Rename or inline the `Proto*` interfaces in `packages/core/src/types/database.ts`:1484-1547.** They're shape helpers, not protobuf. Suggested: drop the `Proto` prefix (`MemoryRetrievalOptionsBase`, etc.) or inline the small bases into their `Omit<...>` callers since each is used exactly once.
4. **Regenerate or scrub the Electrobun pre-built snapshot.** `packages/app-core/platforms/electrobun/build/dev-macos-arm64/elizaOS-dev.app/.../@elizaos/core/src/types/*.ts` still imports `from "./proto.js"`. It's a build artifact, but it's checked into the working tree (~20 files) and contradicts the current source. Either regenerate, gitignore, or delete.
5. **Delete empty `plugins/plugin-music-library/src/prompts/`.** Orphan dir.

### Nice-to-have
6. **Audit the surviving plugin `prompts/*.json` files** (action/evaluator/provider specs) — confirm they're still consumed by `packages/prompts/scripts/generate-plugin-action-spec.js` rather than orphaned alongside the killed `.txt` flow. Out of scope for D1; flag for whoever owns `packages/prompts`.
7. **Consider moving `plugins/plugin-workflow/src/prompts/*.ts` and `plugins/plugin-music/src/prompts/musicPlayerInstructions.ts`** into colocated TS modules (e.g. next to their consumers) to align with the "TS-only" consolidation philosophy. Currently these are isolated `prompts/` subdirs in source — small inconsistency.
