# #11853 — Client Tests lane green: evidence

Lane: `test.yml` → **Client Tests** → `bun run test:client` (build core →
`check:loadperf-bundle` → full `packages/app` + `packages/ui` +
`plugin-personal-assistant` + `plugin-training` vitest suites).

Baseline: develop tip `a747ced409`, clean worktree, fresh
`ELIZA_SKIP_ARTIFACT_SYNC=1 bun install`, `bun run --cwd packages/tui build`
(the CI job's exact prelude). All runs local (the Actions queue has produced
zero non-cancelled `test.yml` completions in the last 100 runs — issue Gap 3).

## Red baseline at `a747ced409` (fail-without-fix)

Run 1 (`bun run test:client`, exact CI command) — **died before any suite ran**:

```
FAIL  maxDuplicateLibBytes: 371.7 KB / budget 341.8 KB
result: FAIL
error: script "check:loadperf-bundle" exited with code 1
error: script "test:client" exited with code 1
```

Running the suites directly (same filters as `test:client`) surfaced the rest:

- `packages/app`: **PASS** (37 files / 316 tests) — issue items 1–5 fixed by #11898
- `plugin-training`: **PASS**
- `packages/ui`: **FAIL — 2 files** (`App.navigate-view-wiring.test.tsx`,
  `App.screen-background-fuzz.test.tsx`): both die at load with
  `No "ACCENT_PRESETS" export is defined on the "./state" mock`
  (drift from d6aedf88dd, the onboarding accent picker)
- `plugin-personal-assistant`: **FAIL — 4 files / 5 tests**, all
  `ScheduledTaskValidationError` fallout of #11809 (see PR body)
- Issue items 7–9: `DynamicViewLoader.test.tsx` and `active-model.test.ts`
  **pass** at this tip (8–9 fixed upstream by a694923ea5 + 149eaa17db)

Also red (same #11809 root cause, plugin-scheduling's own suite):
`dispatch-policy-enforcement.test.ts` — 8/8 tests,
`task.createdBy must be a non-empty string` (fixture omitted the required
field behind an `as` cast).

## Bundle-gate false positive, proven

Content-hashing every dist asset (rollup 8-char hash references stripped, so
true per-entry copies that differ only in hashed sibling-chunk names still
match) against the same `packages/app/dist` the gate failed on:

```
2x 67B each, 67B wasted: assets/network-DAVGex__.js | assets/status-bar-DAVGex__.js
TOTAL true-duplicate waste: 67 bytes brotli   (413 files scanned)
```

The old detector grouped by hash-stripped **basename**: the failing 371.7 KB
"index" group was 26 unrelated modules (the two largest: WalletConnect 112 KB
and Coinbase wallet SDK 107 KB brotli — different libraries, provably not
copies), plus every view's `register-terminal-view-*.js` (533 B–15 KB, also
not copies). One HTML entry point in dist → per-entry duplication impossible.

Detector-still-bites proof (after the fix, budget ratcheted 350 KB → 25 KB):

- planted byte-identical copy of `mermaid-*.js` →
  `FAIL maxDuplicateLibBytes: 95.9 KB / budget 24.4 KB`
- planted copy differing only in an embedded 8-char hashed chunk reference
  (the real per-entry shape) → grouped `3x`, `FAIL 191.8 KB / 24.4 KB`
- clean dist → `PASS maxDuplicateLibBytes: 0.1 KB / budget 24.4 KB`

## Green run at head of this branch (exact CI command)

`bun run test:client` end-to-end — **exit 0**:

- bundle gate: all 5 budget checks **PASS**
  (`maxDuplicateLibBytes: 0.1 KB / budget 24.4 KB`)
- `packages/app`: **PASS** (25.2s; 37 files / 316 tests)
- `packages/ui`: **PASS** (95.2s; 557 files / 5641 tests, 14 skipped)
- `plugin-personal-assistant`: **PASS** (310.8s; 129 files / 1063 tests,
  1056 passed / 7 skipped)
- `plugin-training`: **PASS** (53.4s)
- `bun run --cwd packages/ui test:xr-sim` (the job's final step): **5 passed**
- `plugin-scheduling` (touched by the fix): 19 files / 226 tests pass
- typecheck green: ui, plugin-scheduling, plugin-personal-assistant
- GLSL wallpaper fuzz file: 5/5 consecutive standalone runs green
  (previously flaked on the cold lazy-chunk import; see commit message)

N/A — real-LLM trajectories / screenshots / video: no agent, prompt, or
rendered-UI behavior changed (CI gate metric, test lockstep fixes, one
validation-ownership fix whose route/action surfaces keep identical
status codes and failure text shape).
