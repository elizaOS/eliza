# #13573 Part 1 — walkthrough device matrix must fail when an attempted lane errors

## The bug (vacuous green)

`packages/app/scripts/walkthrough-device-matrix.mjs` computed its process exit
code **only** from `--require`d lanes. With no `--require` flag (the common CI
invocation, e.g. `bun run --cwd packages/app test:e2e:walkthrough:ios`), a lane
that was actually **attempted on an available device/sim and then failed**
(`status: "error"`) still exited `0`. An available-and-erroring iOS lane merged
silently.

The issue cited `:225-226 process.exit(0)`; the tree moved since, so line
numbers shifted. The actual defect lived at the end of `main()`:

```js
const failures = requiredLaneFailures(matrix, args.require);
// ...
process.exit(failures.length ? 1 : 0);
```

`requiredLaneFailures` returns `[]` unless a lane is explicitly required, so an
errored lane produced `0`.

### Defect reproduced (before fix)

```
$ node demo-defect.mjs   # errored ios lane, no --require (as CI runs it)
errored-lane matrix, no --require → requiredLaneFailures: []
current process.exit code: 0 (VACUOUS GREEN — bug present)
```

## The fix

Any lane with `status: "error"` is fatal regardless of `--require` (an `error`
means the device/sim was reachable and the driven journey/capture broke). Honest
`n/a` lanes (host lacks the device) stay **non-fatal** with their recorded
reason — the honest-N/A design and the `--require` escalation are both intact.

New exported pure helpers (unit-testable, single source of truth for the exit
code):

```js
export function erroredLanes(matrix) {
  return Object.entries(matrix).filter(([, result]) => result.status === "error");
}
export function computeExitCode(matrix, required) {
  const fatal =
    erroredLanes(matrix).length || requiredLaneFailures(matrix, required).length;
  return fatal ? 1 : 0;
}
```

`main()` now logs errored lanes separately and exits via
`process.exit(computeExitCode(matrix, args.require))`.

### Delegation path (`--platform ios`) verified

`walkthrough-e2e.mjs` delegates native platforms to the device-matrix runner and
already forwards the child's exit code (`process.exit(code.code ?? 0)`); it only
ever returned green because the matrix produced a green code. Proven that a
non-zero from the matrix now propagates through the delegation:

```
$ node scripts/walkthrough-device-matrix.mjs --platform ios --require ios ; echo $?
direct exit code: 1
$ node scripts/walkthrough-e2e.mjs --platform ios --require ios ; echo $?
delegated exit code: 1
```

Honest-N/A remains green on a device-less host (no false failure):

```
$ node scripts/walkthrough-device-matrix.mjs --platform ios ; echo $?
  ios-simulator      n/a — no booted iOS simulator ...
device-matrix exit code: 0
```

## Test (real, mutation-checked)

Added to `packages/app/scripts/walkthrough-device-matrix.test.mjs`
(`describe("walkthrough device matrix exit code")`): fabricated lane-result sets
assert the computed exit code — all-ok→0, any-error→non-zero, n/a-only→0,
mixed n/a+ok→0, mixed error+n/a→non-zero, plus `--require`d n/a→non-zero.

```
$ bun test scripts/walkthrough-device-matrix.test.mjs
 11 pass
 0 fail
Ran 11 tests across 1 file.
```

Mutation-check — reverting `computeExitCode` to the pre-fix (required-only)
body fails exactly the two error-lane assertions, proving they guard the bug:

```
(fail) ... exits non-zero when ANY attempted lane errored, even without --require
(fail) ... exits non-zero when an errored lane is mixed with honest n/a lanes
 9 pass
 2 fail
```

Runs green under the package's CI runner too
(`bunx vitest run --config vitest.config.ts scripts/walkthrough-device-matrix.test.mjs`
→ `Test Files 1 passed`). Lint clean: `bunx @biomejs/biome check` on both files.

## Part 2 deferred

Part 2 (real iOS journey composition) deferred — needs a live simulator.
Composing the full onboarding/chat/gesture journey for the iOS lane (driving
`ios-onboarding-smoke.mjs` + `mobile-local-chat-smoke.mjs` in-app before the
single-shot `xcrun simctl` capture, since WKWebView has no CDP) is device-gated
and left as a `// TODO(#13573 Part 2)` marker at the sim leg in `captureIos`.
This PR is exit-code correctness only.
