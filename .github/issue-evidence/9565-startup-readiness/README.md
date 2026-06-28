# 9565 startup readiness evidence

## Desktop web renderer trace (M4 Max)

Command:

```bash
bun run --cwd packages/app dev
bun run --cwd packages/app trace:startup -- --runs 2 \
  --out ../../.github/issue-evidence/9565-startup-readiness/desktop-web-renderer-trace-m4max.json
```

Environment:

- Machine: MacBook Pro, Apple M4 Max, 128 GB RAM.
- Date: 2026-06-24 local / 2026-06-25 UTC.
- URL: `http://localhost:2138`.
- Wait goal: `startup-shell:first-paint`.
- Backend: not required; this is the renderer first-paint lane.

Summary:

| Run | Kind | `app-modules` span | `react-mount:end` | `startup-shell:first-paint` | Terminal coordinator phase |
|---|---:|---:|---:|---:|---|
| 0 | cold | 109 ms | 117 ms | 16021 ms | `restoring-session` |
| 1 | warm | 381 ms | 382 ms | 1402 ms | `first-run-required` |

Artifact:

- `desktop-web-renderer-trace-m4max.json`

Notes:

- The trace shows the #9565 critical-path reduction working: `initializeAppModules()` is now a small measured span after deferring non-first-paint plugin UI imports.
- The cold Vite-dev run still spends most time after `createRoot().render()` before `StartupShell` effect paint, so the next local optimization target is React/UI render and dev-server module evaluation rather than app-module import blocking.
