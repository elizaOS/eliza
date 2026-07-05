# #13581 verification — the merged parser regression lane was green-by-skip; now enforced

## Verification (Needs-agent-verify pass)

Reviewing the merged #13581 work (PRs #13918 + #14005), the parser logic and its
14-case suite are genuinely real (pure `string→decision` parsers, a "renamed VIS
→ ABSENT" regression canary, 61 assertions, no mocks-of-the-thing-under-test).

**But the regression lane was not actually enforced.** The suite is
`packages/app/scripts/lib/android-assistant-verify-lib.test.mjs`, which the
`packages/app` vitest lane collects (its `include` covers
`scripts/**/*.test.mjs`) — yet the file imported `test` from **`node:test`**.
Under vitest those registrations are not collected, so vitest reported the file
as **passed with "no tests"**: a parser regression would print a ✗ from node's
runner but the CI lane stays green. That is exactly the green-by-skip the
testing-loop epic (#13620/#13621/#13618) and #13581 itself exist to eliminate.

## Fix

One-line runner change: import `test` from `vitest` instead of `node:test`
(the `node:assert/strict` assertions are unchanged — they throw on failure, so
vitest fails the test identically). The suite now runs in the always-on
`packages/app` lane.

## Proof (`before.txt` / `after-negative.txt`)

- **Before** (`node:test`): `Tests  no tests` — file "passed", nothing enforced.
- **After** (`vitest`): `Tests  14 passed (14)` — collected and enforced.
- **Negative** (corrupt `parseAssistantSurfaces` to defeat the canary): vitest
  reports `Test Files  1 failed`, `× parseAssistantSurfaces treats a renamed VIS
  as ABSENT (regression canary)` — the lane now goes red on a real regression.
