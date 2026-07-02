# Issue 11378 Benchmark Viewer Evidence

## Scope

- Added `smithers` as a first-class trajectory diff harness.
- Added a Playback tab that loads one canonical harness trajectory and steps through recorded prompt, output, tool calls, usage, and metadata.
- Updated the viewer-server trajectory payload to include sibling harness trajectories for the same `(run_group_id, benchmark_id)` even when each harness has a distinct orchestrator run id.
- Kept the change offline and limited to the static viewer plus viewer-server trajectory resolver tests.

## Verification

- `PYTHONPATH=packages python -m pytest packages/benchmarks/orchestrator/tests/test_viewer_server.py -q` passed: 3 tests.
- `PYTHONPATH=packages python -m pytest packages/benchmarks/orchestrator/tests/test_viewer_data.py packages/benchmarks/orchestrator/tests/test_viewer_server.py -q` passed: 9 tests.
- `PYTHONPATH=packages python -m pytest packages/benchmarks/orchestrator/tests/test_viewer_server.py packages/benchmarks/tests/test_runner_normalization.py -q` passed: 9 tests.
- `node --check packages/benchmarks/viewer/app.js` passed.
- `bunx @biomejs/biome check packages/benchmarks/viewer/app.js packages/benchmarks/viewer/index.html packages/benchmarks/viewer/styles.css packages/benchmarks/viewer/README.md` passed.
- `git diff --check` passed.
- `python -m json.tool` passed for the committed fixture, desktop browser log, and mobile browser log.
- `bun run verify` failed before Turbo at the existing type-safety ratchet drift on `develop`: `as unknown as: 80 / 77` and ``?? {}` (core/agent/app-core): `379 / 377`.

## Browser Evidence

Temporary server:

```bash
PYTHONPATH=packages python -m benchmarks.orchestrator serve-viewer --host 127.0.0.1 --port 8766
```

Fixture data is committed under `11378-viewer-fixture/results/` and was copied into the gitignored `packages/benchmarks/benchmark_results/` before serving. The fixture uses distinct run ids for `eliza`, `smithers`, and `random_v1` so the UI exercises sibling trajectory discovery rather than same-run-id grouping.

Artifacts:

- `11378-smithers-diff.png` - manually reviewed; diff group and diff table both show `smithers` alongside `eliza` and `random_v1`.
- `11378-playback-step0.png` - manually reviewed; Playback selected `smithers`, shows step index 0 prompt/output/usage/metadata, and Next enabled.
- `11378-playback-step1.png` - manually reviewed; step index 1 shows Smithers output and `inspect_order` tool call.
- `11378-smithers-diff-mobile.png` - manually reviewed at 390px width; long run ids wrap inside cards/panel title, tables remain in horizontal scroll containers.
- `11378-playback-step1-mobile.png` - manually reviewed at 390px width; playback cards stack and the step-1 tool call remains readable.
- `11378-playback-walkthrough.webm` - Playwright recording of the diff and playback flow.
- `11378-viewer-browser-logs.json` - browser assertions and console/network logs.
- `11378-viewer-mobile-logs.json` - mobile viewport assertions and console/network logs.

Browser assertions:

```json
{
  "title": "elizaOS Benchmark Viewer",
  "diffGroupCount": 1,
  "smithersDiffHeaderCount": 1,
  "diffHarnesses": ["Step", "eliza", "smithers", "random_v1"],
  "apiHarnesses": ["eliza", "random_v1", "smithers"],
  "apiTaskIds": {
    "eliza": ["run_woobench_20260702T103000Z_1_eliza"],
    "smithers": ["run_woobench_20260702T103001Z_1_smithers"],
    "random_v1": ["random_v1_woobench_20260702T102900Z_1_baseline"]
  },
  "playbackHarness": "smithers",
  "playbackTitle": "woobench :: run_woobench_20260702T103001Z_1_smithers",
  "playbackStepTotal": "2 of 2 (recorded step_index 1)",
  "step1ToolVisibleCount": 1,
  "consoleErrorCount": 0,
  "failedNetworkCount": 0
}
```

Mobile assertions:

```json
{
  "diffTitleBox": { "x": 35, "y": 890.734375, "width": 320, "height": 84 },
  "playbackTitleBox": { "x": 35, "y": 155.734375, "width": 320, "height": 84 },
  "viewportWidth": 390,
  "smithersDiffHeaderCount": 1,
  "playbackHarness": "smithers",
  "playbackStepTotal": "2 of 2 (recorded step_index 1)",
  "step1ToolVisibleCount": 1,
  "consoleErrorCount": 0,
  "failedNetworkCount": 0
}
```

Server/browser logs showed 200 responses for `/`, `/api/viewer-data`, `/app.js`, `/styles.css`, and `/api/trajectories/rg_11378_demo/woobench/run_woobench_20260702T103001Z_1_smithers`.

## N/A

- Live-model trajectory: N/A - issue acceptance is explicitly frontend + viewer-server only and offline/no credentials required. The committed fixture uses canonical trajectory JSONL records shaped like the viewer-server endpoint consumes.
