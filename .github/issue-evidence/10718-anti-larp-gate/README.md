# #10718 — anti-larp CI gate (focused / orphaned-skip regression guard)

Closes the named #10718 acceptance criterion **"New CI gate prevents regression
(no `.only`, no un-tracked skips)"**. Before this, biome did not enable
`noFocusedTests`/`noSkippedTests` and no script forbade `.only` — the tree was
clean by discipline only, so a single `it.only` (which silently drops every
sibling test in the file) or a bare `it.skip("real test", fn)` could land and
turn a suite green while not running.

## What ships
- `packages/scripts/audit-focused-skipped-tests.mjs` — the gate (+ `--self-test`, `--dry-run`).
- `package.json`: `audit:focused-tests`, `audit:focused-tests:self-test`.
- `.github/workflows/ci.yaml`: wired into the **Develop Gate** job (self-test then gate),
  alongside the type-safety, UI-determinism, and lane-coverage gates.

## What it enforces
- **Fails** on any focused test: `describe.only` / `it.only` / `test.only` /
  `suite.only` / `bench.only` / `context.only` / `fit(` / `fdescribe(`. Zero tolerance.
- **Fails** on an *orphaned* hardcoded skip: `it.skip("name", fn)` / `.todo` /
  `xit(` / `xdescribe(` with **no** tracking ref, self-documenting reason, deny-list
  reference, or Playwright skip `annotation`.
- **Allows** (not larp): the conditional-runner pattern `cond ? describe : describe.skip`
  and `test.skip(cond, "reason")` (env/dependency-gated real & live suites that skip
  cleanly), self-documenting skips (`"[live] requires OPENAI_API_KEY"`, `"not on linux"`),
  Playwright `annotation: { type: "skip", description }`, and `#issue` / `.pr-deny-list.json`
  tracked skips.

## Evidence
- `self-test-output.txt` — **20/20** classifier cases pass (focused forms flagged,
  conditional/documented skips allowed, `it.only`-in-a-comment and `{ only: true }`
  property ignored, bare orphaned skip flagged).
- `scan-output.txt` — live scan of **4331 tracked test files**: **0 focused, 0 orphaned**
  (clean). During development the gate correctly surfaced then re-classified the two
  documented Playwright-annotation skips in `packages/app/test/ui-smoke/multi-*.spec.ts`
  (they carry a skip annotation + `.pr-deny-list.json` ref → compliant, not orphaned),
  proving both the detection and the false-positive handling.

Scoped to the regression-gate deliverable; the broader semantic-larp remediation
(mock-standing-in-for-unit, green-but-meaningless) is the per-surface work tracked
across the coordinated de-larp push.
