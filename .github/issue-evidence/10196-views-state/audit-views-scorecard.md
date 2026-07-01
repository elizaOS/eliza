# #10196 audit:views scorecard

Budget: every registered view path must be reached at least once; render guard
severity must stay below `error`; worst per-view runtime render count must stay
below 400; collected heap after churn must stay under 2.2x the warm baseline;
module/view caches must emit at least one real eviction during churn or forced
release.

## Summary

- Views reached: 22/22
- Visible first-run chooser blocks: 0
- Render-guard errors: 0
- Module/view evictions attributed in scorecard: 58
- Module cleanups attributed in scorecard: 0
- Heap series: 225.2MB -> 213.4MB -> 214.7MB (1.01x)
- Raw artifacts: `audit-views-render-telemetry.json`, `audit-views-runtime-telemetry.json`, `audit-views-module-cache-telemetry.json`, `audit-views-heap-series.json`, `audit-views-frontend-log.json`, `audit-views-network-log.json`
- Video: `audit-views-soak.webm`

## Per-View Scorecard

| view | kind | path | reached | first-run | runtime ids | show | max renders | render guard | evict | cleanup |
|---|---:|---|---:|---:|---|---:|---:|---:|---:|---:|
| Tutorial | system | /tutorial | 2/2 | 0 | tutorial | 1 | 1 | clean | 2 | 0 |
| Chat | system | /chat | 2/2 | 0 | chat | 0 | 0 | clean | 2 | 0 |
| Help | system | /help | 2/2 | 0 | help | 1 | 1 | clean | 2 | 0 |
| Camera | preview | /camera | 2/2 | 0 | camera | 1 | 1 | clean | 2 | 0 |
| Character | system | /character | 2/2 | 0 | character | 2 | 1 | clean | 3 | 0 |
| Knowledge | system | /character/documents | 2/2 | 0 | documents | 2 | 1 | clean | 4 | 0 |
| Automations | preview | /automations | 2/2 | 0 | automations | 2 | 1 | clean | 2 | 0 |
| Plugins | preview | /apps/plugins | 2/2 | 0 | plugins-page, apps:plugins, plugins | 2 | 1 | clean | 4 | 0 |
| Trajectories | developer | /apps/trajectories | 2/2 | 0 | trajectories, apps:trajectories | 2 | 1 | clean | 4 | 0 |
| Transcripts | system | /apps/transcripts | 2/2 | 0 | transcripts, apps:transcripts | 2 | 1 | clean | 4 | 0 |
| Memories | preview | /apps/memories | 2/2 | 0 | memories, apps:memories | 2 | 1 | clean | 4 | 0 |
| Database | developer | /apps/database | 2/2 | 0 | database, apps:database | 2 | 1 | clean | 4 | 0 |
| Logs | developer | /apps/logs | 2/2 | 0 | logs, apps:logs | 2 | 1 | clean | 4 | 0 |
| Settings | system | /settings | 2/2 | 0 | settings | 2 | 1 | clean | 4 | 0 |
| Background | preview | /background | 2/2 | 0 | background | 2 | 1 | clean | 2 | 0 |
| Cockpit | developer | /cockpit | 2/2 | 0 | cockpit | 2 | 1 | clean | 0 | 0 |
| Feed | system | /feed | 2/2 | 0 | feed | 2 | 1 | clean | 5 | 0 |
| Inbox | plugin | /inbox | 2/2 | 0 | inbox | 2 | 1 | clean | 2 | 0 |
| Orchestrator | developer | /orchestrator | 2/2 | 0 | orchestrator | 0 | 0 | clean | 0 | 0 |
| Screen Share | plugin | /screenshare | 2/2 | 0 | screenshare | 0 | 0 | clean | 0 | 0 |
| Task Coordinator | preview | /task-coordinator | 2/2 | 0 | task-coordinator | 0 | 0 | clean | 0 | 0 |
| Trajectory Logger | developer | /trajectory-logger | 2/2 | 0 | trajectory-logger | 2 | 1 | clean | 4 | 0 |
