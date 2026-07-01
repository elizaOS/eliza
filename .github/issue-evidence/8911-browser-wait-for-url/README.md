# Issue #8911 evidence: browser wait_for_url

## What this proves

The deterministic browser scenario now exercises the full missing path from
issue #8911:

- `BROWSER_WAIT_FOR_URL` opens/navigates `https://scenario.test/oauth/start`.
- The action streams the initial watch message and a "still waiting" status.
- The seeded browser workspace navigates the same tab to
  `https://scenario.test/oauth/callback?code=scenario`.
- The action resolves with `status: "matched"`, `matched: true`, and
  `lastUrl` set to the callback URL.
- The scenario restores the seeded form tab afterward and then runs the existing
  deterministic browser action catalog (`get`, `wait`, `type`, `click`,
  `screenshot`, `open`, `list_tabs`, `close`).

## Commands run

```bash
bunx biome check plugins/plugin-browser/src/actions/browser.ts plugins/plugin-browser/src/actions/browser.test.ts packages/scenario-runner/test/scenarios/deterministic-browser-actions.scenario.ts
```

Result: passed.

```bash
bun run --cwd plugins/plugin-browser test -- src/actions/browser.test.ts src/actions/wait-for-url.test.ts src/actions/wait-for-url-predicate.test.ts
```

Result: passed, 3 files / 24 tests.

```bash
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 ELIZA_SAVE_TRAJECTORIES=1 bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts run test/scenarios --scenario deterministic-browser-actions --lane pr-deterministic --run-dir /Users/shawwalters/.codex/worktrees/94c9/eliza/.github/issue-evidence/8911-browser-wait-for-url/run --report /Users/shawwalters/.codex/worktrees/94c9/eliza/.github/issue-evidence/8911-browser-wait-for-url/scenario-report.json --export-native /Users/shawwalters/.codex/worktrees/94c9/eliza/.github/issue-evidence/8911-browser-wait-for-url/native.jsonl
```

Result: passed, 1 scenario passed / 0 failed / 0 skipped.

## Artifacts

- `scenario-report.json` - scenario summary and turn-level action results.
- `run/viewer/index.html` - generated run viewer for manual review.
- `run/viewer/data.js` - viewer data.
- `run/matrix.json` - scenario matrix output.
- `native.jsonl` - native trajectory export, 16 rows.
- `native.manifest.json` - native export manifest, 16 passed rows / 0 failed
  rows.
- `8911-browser-wait-for-url-summary.png` - manually reviewed visual summary
  generated from the passed scenario report.

The raw per-trajectory source files produced under `run/trajectories/` were not
committed because `native.jsonl` is the committed native trajectory export and
`run/viewer/data.js` contains the viewer data needed for review.

## Manual review notes

The first turn in `scenario-report.json` is `wait for browser URL callback` and
contains a `BROWSER_WAIT_FOR_URL` action call with:

- `url: "https://scenario.test/oauth/start"`
- `pattern: "callback?code=scenario"`
- `pollIntervalMs: 50`
- `timeoutMs: 4000`
- `values.status: "matched"`
- `values.matched: true`
- `values.polls: 2`
- `outcome.lastUrl: "https://scenario.test/oauth/callback?code=scenario"`

The response text includes the user-visible progress stream: opened/watching,
still waiting at the start URL, then done at the callback URL.

Video is marked N/A for this issue because the changed surface is the browser
plugin action plus scenario evidence, not a rendered app UI flow. A direct
`file://` capture of the generated scenario viewer was blocked by the in-app
browser URL policy, so `8911-browser-wait-for-url-summary.png` was generated
from the JSON report instead and manually opened for legibility. The scenario
itself includes a browser screenshot action later in the catalog and verifies
that action still succeeds after the wait-for-url callback path.
