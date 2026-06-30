# Issue #10196 — `audit:views` soak scorecard

> Budget (fail on any): every view opens (crash isolation) · render-loop ERROR severity = 0 views · retained cacheSize ≤ 16 · post-warmup heap NOT (slope > 2.0 MiB/pass AND monotonic ≥ 0.6) AND growth ratio ≤ 1.5 · render-telemetry plumbing live.

- views enumerated from `/api/views`: **27** (unknown: 27)
- cycles: **5** (first = warmup, discarded from heap trend) · render telemetry plumbing live: **true**
- render-telemetry events: 0 (severity=error → render-loop) · module-cache events: 1 (with live heap: 1)
- module cache: loads 1 · evicts 0 · cleanups 0 · peak cacheSize 1

- heap samples (per-pass, post-GC): 46.4M → 56.7M → 55.0M → 59.1M → 56.9M
- post-warmup heap: slope 0.45 MiB/pass · growth ratio 1.002 · monotonic 0.33 · **verdict: ok**

## Per-view

| view | kind | opened | peak render updates/window | render-loop |
| --- | --- | --- | --- | --- |
| `calendar` | unknown | yes | 0 | no |
| `companion` | unknown | yes | 0 | no |
| `contacts` | unknown | yes | 0 | no |
| `feed` | unknown | yes | 0 | no |
| `finances` | unknown | yes | 0 | no |
| `focus` | unknown | yes | 0 | no |
| `goals` | unknown | yes | 0 | no |
| `health` | unknown | yes | 0 | no |
| `hyperliquid` | unknown | yes | 0 | no |
| `inbox` | unknown | yes | 0 | no |
| `messages` | unknown | yes | 0 | no |
| `model-tester` | unknown | yes | 0 | no |
| `orchestrator` | unknown | yes | 0 | no |
| `phone` | unknown | yes | 0 | no |
| `polymarket` | unknown | yes | 0 | no |
| `relationships` | unknown | yes | 0 | no |
| `screenshare` | unknown | yes | 0 | no |
| `shopify` | unknown | yes | 0 | no |
| `social-alpha` | unknown | yes | 0 | no |
| `steward` | unknown | yes | 0 | no |
| `task-coordinator` | unknown | yes | 0 | no |
| `todos` | unknown | yes | 0 | no |
| `training` | unknown | yes | 0 | no |
| `trajectory-logger` | unknown | yes | 0 | no |
| `vector-browser` | unknown | yes | 0 | no |
| `views-manager` | unknown | yes | 0 | no |
| `wallet` | unknown | yes | 0 | no |

