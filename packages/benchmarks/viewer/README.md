# Benchmark Viewer

Static single-page UI for inspecting normalized elizaOS benchmark results. No build step — plain HTML + vanilla JS + CSS served directly by the orchestrator's built-in HTTP server.

## Files

| File | Purpose |
|---|---|
| `index.html` | Shell: summary cards, filterable runs table, latest-scores table, synthetic-baselines table, and a Trajectory Diff tab |
| `app.js` | All client logic: fetches `/api/viewer-data`, filters/sorts runs, computes diff groups across harnesses (`eliza`, `openclaw`, `hermes`, `random_v1`), renders step-aligned trajectory diffs via `/api/trajectories/<run_group>/<benchmark>/<task>` |
| `styles.css` | Scoped styles; no external dependencies |

## How it is served

```
python -m benchmarks.orchestrator serve-viewer [--host HOST] [--port PORT]
```

The server (`orchestrator/viewer_server.py`) does two things:

1. Serves this directory as static files (`/` → `index.html`).
2. Exposes two JSON API endpoints:
   - `GET /api/viewer-data` — builds the full dataset from `benchmark_results/orchestrator.sqlite` (or falls back to `benchmark_results/viewer_data.json`).
   - `GET /api/trajectories/<run_group_id>/<benchmark_id>/<task_id>` — returns per-harness canonical trajectory entries for the Trajectory Diff view.

The viewer is not a standalone app; it has no package.json and cannot be opened directly from `file://` when served data is needed (API calls will fail). Always use the `serve-viewer` command.
