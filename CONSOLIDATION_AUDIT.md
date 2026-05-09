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

### 3. `Proto*` identifiers / `from "./proto.js"` — ✅ addressed
- Electrobun `build/` output is **gitignored** (`packages/app-core/platforms/electrobun/build/`); remove local trees when scrubbing stale snapshots — they are not tracked.
- `packages/core/src/types/database.ts` uses internal bases named `*OptionsBase` (not `Proto*`).

### 4. `build:prompts` scripts — ✅ clean
No `package.json` under `packages/*` or `plugins/*` defines `build:prompts`.

### 5. `generate-plugin-prompts.js` / `packages/prompts/scripts/generate.js` references — ✅ clean
Not referenced anywhere. The `packages/prompts/scripts/` dir now contains only `check-secrets.js`, `generate-action-docs.js`, `generate-plugin-action-spec.js`, `prompt-compression.js`.

### 6. Stale `generated/prompts/` dirs — ✅ clean (plugins)
Empty `plugins/plugin-{farcaster,discord}/generated/prompts/typescript/` dirs are removed when absent from checkout; only `generated/specs/` remains under those plugins’ `generated/` trees.

### 7. `.bufrc` / `buf.*.yaml` / `buf.lock` / `.bufgenmissing` — ✅ clean
None found in `packages|plugins`.

### 8. `.github` workflows — ✅ clean
No `bunx buf` / `buf generate` / `buf lint` / `generate:types` / `generate-plugin-prompts` references anywhere under `.github/`.

### 9. Top-level plugin `prompts/` dirs — ✅ documented + TS colocated
Hand-edited plugin **`prompts/*.json`** files are documented in `packages/prompts/README.md` (per-plugin codegen vs `generate-plugin-action-spec.js`). Workflow LLM strings live under `plugins/plugin-workflow/src/utils/workflow-prompts/`. Music action docs live at `plugins/plugin-music/src/actions/music-player-action-docs.ts`.

### 10. Imports of `generated/prompts/typescript/prompts` — ✅ clean
No source `.ts` file outside `node_modules`/`dist` imports the deleted path.

### 11. `@elizaos/prompts` re-export wiring — ✅ clean
`packages/core/src/prompts.ts` is a 5-line `export * from "@elizaos/prompts"` re-export pointing at the hand-written source. Not the stale 1298-line dist copy.

### 12. `packages/core` e2e smoke — ⚙️ Cerebras-friendly preflight
Playwright global setup (`packages/core/e2e/setup/global-setup.ts`) now forwards `OPENAI_BASE_URL` from the environment and, when `OPENAI_API_KEY` looks like a Cerebras key (`csk-…`) and no base URL is set, defaults to `https://api.cerebras.ai/v1` and `MILADY_PROVIDER=cerebras` so preflight does not hit `api.openai.com`. **Pass/fail still depends on a valid live key** — run `bun run --cwd packages/core test:e2e:smoke` with credentials to certify 9/9.

---

## Follow-ups (resolved / how to verify)

| Item | Status |
|------|--------|
| Empty `generated/prompts/typescript/` under plugins | Removed/absent in tree; farcaster/discord only keep `generated/specs/`. |
| E2e smoke with working inference key | Run `bun run --cwd packages/core test:e2e:smoke` with `OPENAI_API_KEY` (or other supported provider env). Cerebras: `csk-…` key works without manually setting base URL after the global-setup change. |
| `Proto*` names in `database.ts` | Renamed to `*OptionsBase` in source. |
| Electrobun snapshot / `proto.js` in bundle | `build/` gitignored; delete local `packages/app-core/platforms/electrobun/build` to scrub; regenerate via platform build when needed. |
| Empty `plugin-music-library/src/prompts/` | Not present in this checkout (no `prompts` under `plugin-music-library/src`). |
| Plugin `prompts/*.json` vs generators | Documented in `packages/prompts/README.md` — JSON feeds plugin codegen; `generate-plugin-action-spec.js` scans TS actions only. |
| Colocate workflow/music TS prompts | Workflow → `src/utils/workflow-prompts/`; music docs → `src/actions/music-player-action-docs.ts`. |
