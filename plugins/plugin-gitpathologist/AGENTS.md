# @elizaos/plugin-gitpathologist

Forensic git-history analysis for Eliza agents: per-surface health timeline, drift inflection detection, and LLM-narrated rot post-mortem.

## Purpose / role

This plugin adds git repository forensics to any Eliza agent running in a Node.js environment. It answers questions like "when did this code get bad?" or "where did rot start in `src/payments/`?" by walking `git log`, scoring each commit, detecting quality inflection points, and optionally calling the agent's configured small-text model to write a narrative explanation.

The plugin is opt-in by default unless `ELIZA_GITPATHOLOGIST=true` is set or the service is listed explicitly. It auto-detects whether the workspace has a `.git` directory at service start.

## Plugin surface

| Kind | Name | What it does |
|---|---|---|
| **Service** | `git_pathology` (`GIT_PATHOLOGY_SERVICE_NAME`) | On-demand analysis orchestrator. Registers the pipeline and cache; all action calls go through it. |
| **Action** | `GIT_PATHOLOGY` | Multiplex action: `action=report` runs a full pathology analysis for a surface path/glob; `action=list` lists cached reports. Similes: `ANALYZE_GIT_PATHOLOGY`, `GIT_HEALTH`, `GIT_FORENSICS`, `PATHOLOGY_REPORT`, `CODE_HISTORY_HEALTH`, `WHERE_DID_ROT_START`. |

No providers, evaluators, routes, or event handlers are registered.

## Layout

```
src/
  index.ts                   Plugin object export; wires service + action
  types.ts                   All shared types: SurfaceSpec, AnalysisOptions,
                               RawCommit, ClassifiedCommit, CommitHealthPoint,
                               InflectionPoint, RotCause, PathologyReport,
                               CachedReportSummary, Operation
  render.ts                  Markdown renderer: PathologyReport → string
  secret-scrubber.ts         Regex-based secret redaction (API keys, tokens,
                               bearer headers, env-name=value patterns)
  actions/
    git-pathology.ts         GIT_PATHOLOGY action handler and parameter parsing
  services/
    git-pathology-service.ts GitPathologyService class; coordinates pipeline
  pipeline/
    scan.ts                  Phase 1 — git log parsing (deterministic, no LLM)
    classify.ts              Phase 2 — rule-based commit type + risk-flag tagging
    score.ts                 Phase 3 — per-commit health delta + EMA scoring
    inflect.ts               Phase 4 — peak and drift inflection detection
    narrate.ts               Phase 5 — LLM narration for drift commits (optional)
  cache/
    report-cache.ts          Disk-backed JSON cache keyed by sha256(surface+since)
```

## Pipeline (scan → classify → score → inflect → narrate)

1. **scan** — calls `git log --numstat` once for the surface path/glob. No LLM. Returns `RawCommit[]`.
2. **classify** — regex + prefix rules assign `CommitType` and `riskFlags` to each commit. Returns `ClassifiedCommit[]`.
3. **score** — deterministic EMA scoring (α=0.3). Each commit gets a `delta` and running `score`. Reverts targeting commits within the lookback window apply a proximity penalty. Returns `CommitHealthPoint[]`.
4. **inflect** — detects peaks (local EMA maxima) and drift onsets (sustained score drops ≥0.25 over 5 commits). Returns up to 5 peaks and 5 drifts as `InflectionPoint[]`.
5. **narrate** — one `ModelType.TEXT_SMALL` call per drift, capped by `budget`. Fetches `git show` diff snippets (up to 8 KB, scrubbed of secrets) and asks the model to classify a `RotCategory` and write a 2-3 sentence narrative. Falls back to deterministic narration when the runtime has no model or `budget=0`.

Reports are cached by key = `sha256(surface + '\0' + since)`. A cache hit is only valid when the repo HEAD sha matches the stored `headSha`.

## Commands

All scripts require a built `dist/` (run `build` first or use the repo-level turborepo pipeline).

```bash
bun run --cwd plugins/plugin-gitpathologist build         # tsdown compile
bun run --cwd plugins/plugin-gitpathologist test          # vitest run
bun run --cwd plugins/plugin-gitpathologist typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-gitpathologist lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-gitpathologist lint:check    # biome check (no write)
bun run --cwd plugins/plugin-gitpathologist format        # biome format --write
bun run --cwd plugins/plugin-gitpathologist format:check  # biome format (no write)
bun run --cwd plugins/plugin-gitpathologist clean         # rm dist .turbo
```

## Config / env vars

| Variable | Type | Required | Default | Description |
|---|---|---|---|---|
| `ELIZA_GITPATHOLOGIST` | boolean | No | auto | Force-enable (`true`) or force-disable (`false`) the plugin. When unset, plugin auto-enables if a `.git` directory is present. |
| `GITPATHOLOGIST_BUDGET` | number | No | `20` | Maximum LLM narration calls per analysis. Set to `0` to run fully deterministic (no model calls). |
| `GITPATHOLOGIST_CACHE_DIR` | string | No | `<repoRoot>/.gitpathology` | Override the cache directory. Relative paths are resolved against `repoRoot`. |

The action reads `ELIZA_WORKSPACE_DIR` to resolve the repo root when running inside an Eliza agent workspace; falls back to `process.cwd()` when the variable is unset.

## How to extend

### Add an action

1. Create `src/actions/<name>.ts` exporting a typed `Action` object.
2. Import it in `src/index.ts` and append it to `gitpathologistPlugin.actions`.
3. Add a test in `__tests__/`.

### Add a pipeline phase

1. Create `src/pipeline/<phase>.ts` with a pure function `(input: PreviousOutput[]) => NextOutput[]`.
2. Call it in `GitPathologyService.runReport()` (`src/services/git-pathology-service.ts`) after the appropriate existing phase.
3. Add or extend types in `src/types.ts` and re-export from `src/index.ts` if callers need the type.

### Add a provider

1. Create `src/providers/<name>.ts` exporting a typed `Provider` object.
2. Import and push into `gitpathologistPlugin.providers` (currently an empty array).

## Conventions / gotchas

- **`git` binary required at runtime.** The scan phase calls `spawnSync("git", ...)` directly. The plugin will fail to start meaningfully in environments without `git` on `PATH`.
- **Node-only.** `exports.node` is the sole distribution target. Do not add browser-compatible code paths.
- **Secret scrubbing is mandatory before LLM calls.** All commit text and diff snippets pass through `scrubSecretsDeep` before leaving the process or being stored in cache. Never bypass this.
- **Cache is HEAD-keyed, not time-keyed.** Any commit to the repo invalidates existing cache entries for that surface. This is intentional.
- **Narrate falls back gracefully.** If the runtime provides no `useModel` function or `budget=0`, `narrate()` uses `deterministicRotCause()` and logs a warning. The report is still valid.
- **No background work.** The service has no timers or subscriptions. Everything is on-demand via `runReport()`.
- **Logging prefix:** `[GitPathologyService]`, `[GitPathology/narrate]`. Use `logger` from `@elizaos/core` for all log output; see root AGENTS.md for the logger-only rule.
