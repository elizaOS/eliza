# @elizaos/plugin-gitpathologist

Forensic git-history analysis for elizaOS agents.

## What it does

This plugin gives an Eliza agent the ability to analyze the commit history of a file, directory, or path glob and produce a structured health report. It answers questions such as:

- "When did the code quality in `src/payments/` start degrading?"
- "Where did rot begin in this module?"
- "What does the quality timeline look like for the last month?"

The analysis runs a five-phase pipeline: parse `git log`, classify each commit by type, score commits on a health scale using an exponential moving average, detect quality peaks and drift inflections, then (optionally) call the agent's configured text model to write a narrative post-mortem for each drift event.

Reports are cached on disk keyed to the repository HEAD sha, so repeat queries within the same commit are instant.

## Capabilities

### Action: `GIT_PATHOLOGY`

The plugin registers a single multiplex action with two operations:

**`action=report`** (default) — full pathology analysis for a surface.

Parameters:
| Parameter | Required | Default | Description |
|---|---|---|---|
| `surface` | Yes | — | Path or glob relative to repo root (e.g. `src/payments/`, `**/*.test.ts`) |
| `since` | No | `14d` | Lookback window. ISO date or relative (`14d`, `4w`, `2m`). |
| `budget` | No | `20` | Max LLM narration calls. `0` = fully deterministic, no model calls. |
| `cache` | No | `auto` | `auto` (use cache when HEAD matches), `force` (recompute), `read-only` (fail on miss). |

Output: a Markdown report with:
- Commit count, authors, and analysis window
- **Peaks** — local maxima of health score (best moments in the window)
- **Drift inflections** — commits where a sustained quality drop begins
- **Rot post-mortem** — per-drift narrative (LLM-generated if model available, deterministic otherwise)

**`action=list`** — list cached reports for the current repo root. No parameters required.

### Trigger phrases

The agent will activate this action when the user says things like:
- "analyze git pathology for X"
- "when did this code get bad"
- "where did rot start in X"
- "code health for X"
- "drift analysis for X"

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `ELIZA_GITPATHOLOGIST` | auto | Set `true` to force-enable, `false` to force-disable. When unset, the plugin auto-enables in workspaces with a `.git` directory. |
| `GITPATHOLOGIST_BUDGET` | `20` | Maximum LLM narration calls per analysis. Set to `0` to skip LLM narration entirely. |
| `GITPATHOLOGIST_CACHE_DIR` | `<repoRoot>/.gitpathology` | Override the cache directory for pathology reports. |

## Requirements

- Node.js runtime (not available on mobile/browser targets).
- `git` must be present on `PATH`.
- An Eliza agent runtime with a configured `TEXT_SMALL` model for LLM narration (optional — the plugin degrades gracefully to deterministic narration without one).

## Enabling the plugin

Add `@elizaos/plugin-gitpathologist` to your agent's plugin list:

```ts
import gitpathologistPlugin from "@elizaos/plugin-gitpathologist";

const agent = new AgentRuntime({
  plugins: [gitpathologistPlugin],
  // ...
});
```

## Example output

```
# Git Pathology — `src/payments/`

**Repo:** `/home/user/myproject`
**Window:** 2025-05-01 → 2025-05-31
**HEAD:** `a1b2c3d`
**Commits analyzed:** 47 (alice, bob, carol)
**LLM calls:** 3

## Peaks (local maxima of health)

- `f3a1b2c` (2025-05-10, alice): score 0.61 +0.40 — clean refactor, low churn

## Drift inflections (sustained downturns)

- `9d2c4e1` (2025-05-22, bob): score 0.12 -0.49 — score drops 0.49 over next 5 commits flags=large-churn

## Rot post-mortem

### churn-spiral — `9d2c4e1`..`7a3f9b0`

This commit introduced 1,240 churn lines across 23 files with no test coverage changes, signaling a large undisciplined patch...
```

## License

MIT
