# #10718 — Test-suite de-larp: CI gate for exclusive/orphaned/never-run tests

Human-verifiable evidence for the first shippable slice of the whole-repo
de-larp epic (#10718): a **test-integrity CI gate** that closes the two silent
larp vectors no existing check caught, plus an honest inventory of never-run
test files.

## What shipped

| Artifact | Path |
| --- | --- |
| Gate | `packages/scripts/lint-test-integrity.mjs` |
| Self-test (classifier lock) | `packages/scripts/lint-test-integrity.self-test.mjs` |
| Ratchet allowlist | `packages/scripts/lint-test-integrity.allowlist.json` |
| Wiring | `package.json` → `lint`, `test:lint`, `test:lint:test-integrity` |

The gate runs in CI today through the existing `bun run lint` step
(`.github/workflows/ci.yaml`), so no workflow-file change is required. It sits
alongside the existing `lint-no-vi-mocks` / `lint-lane-coverage` lints, but works
at the individual test-call granularity that those two do not.

## The three checks

**A. Exclusive tests — `.only` / `fit` [BLOCKING, no allowlist].**
A single `describe.only`/`it.only`/`test.only`/`fdescribe`/`fit` silently drops
every sibling test in its file while the suite still reports green. Repo target
is zero; there is no suppression path.

**B. Orphaned disabled tests [BLOCKING, ratchet allowlist].**
A *declared* skip (`it.skip("title", fn)` / `describe.skip("title", fn)` /
`xit` / `xdescribe`) whose callback body is **non-empty** is a real test with its
assertions disabled. It must either link a tracking issue (`#NNN` / issues URL /
`ELIZA-NN` in an adjacent comment or the title) or be grandfathered in the
allowlist with a written reason. **New** untracked orphaned skips fail the build;
**unused** allowlist capacity also fails, so the debt only ratchets down.

Correctly **not** flagged (legitimate runtime gates, locked by the self-test):
- conditional skips `test.skip(!HAS_KEY, "reason")` — first arg is a condition;
- dynamic skips `test.skip("reason")` — single arg, no callback;
- empty-body placeholders `it.skip("[live] …", () => {})` — the sanctioned
  idiom for signalling an env/platform/live-key gate in the report.

**C. Never-run test files [INFORMATIONAL].**
`*.real.test.ts` / `*.real.e2e.test.ts` only run in the `post-merge` lane (never
in the deterministic PR lane), and files under a package tree where no ancestor
declares a `test*` script are claimed by no lane. Reported, not gated (a hard
gate needs full per-package vitest include/exclude evaluation and would be
false-positive-prone).

## Verified against `origin/develop`

The gate binary is tree-independent; the numbers below were confirmed against
`origin/develop`'s current content (read from the git object store, then the
gate run over the materialized declared-skip/exclusive files):

- **Exclusive tests: 0.** `git grep` over all `*.test.ts*` / `*.spec.ts*` finds
  no `describe/it/test.only`, no `fdescribe`/`fit`, no `xit`/`xdescribe`.
- **Orphaned disabled tests: 3, all allowlisted with a reason** (below). The
  gate exits `0` on develop.

```
[lint-test-integrity] PASS test-integrity gate
  exclusive (.only/fit)     : 0  [blocking, target 0]
  orphaned disabled tests   : 0  [blocking — untracked, not allowlisted]
  suppressed (allowlisted)  : 3
```

The three grandfathered skips (each `reason` references #10718):

| File | Why disabled |
| --- | --- |
| `packages/app/test/ui-smoke/multi-client-desync.spec.ts` | cross-client convergence e2e — needs two live browser contexts + real BroadcastChannel; not in the deterministic ui-smoke lane |
| `packages/app/test/ui-smoke/multi-window-sync.spec.ts` | cross-window `useTabSync`/BroadcastChannel propagation — needs two same-context pages |
| `packages/cloud/api/test/e2e/group-g2-mcp-registry.test.ts` | MCP registry CRUD writes 500 under the workerd + PGlite-over-TCP harness (Broken pipe on the 48-col INSERT); passes on real Postgres/Railway |

The larger debt this gate first surfaced locally (a vacuous `describe.skip`
leaderboard stub, plus ~20 disabled feed-engine/app-PA tests) was already
removed or un-skipped on `develop` by in-flight de-larp work — which is exactly
why the ratchet starts at just 3 and is designed to keep shrinking.

## Adversarial proof — the gate blocks planted violations

A file with a planted `describe.only` and a planted untracked
`it.skip("…", () => { expect(compute()).toBe(42); })` was dropped into
`packages/core/src/` and then removed:

```
[lint-test-integrity] FAIL test-integrity gate
  exclusive (.only/fit)     : 1  [blocking, target 0]
  orphaned disabled tests   : 1  [blocking — untracked, not allowlisted]

  - packages/core/src/__integrity_probe__.test.ts:4: describe.only("planted focus", () => {
  - packages/core/src/__integrity_probe__.test.ts:9: it.skip("planted disabled real test", () => {
```

Exit code `1`. After removing the plant, exit `0`.

## Classifier self-test (38 assertions)

```
[lint-test-integrity.self-test] PASS 38 assertions
```

Covers: the source neutraliser (a `.only`/`.skip` inside a comment, a string
literal, or a regex literal containing a quote never produces a false match, and
line numbers stay accurate); exclusive detection incl. the `fitAddon.fit()`
false-positive guard; conditional/dynamic/placeholder skips exempted; non-empty
declared skips flagged; tracking-ref and allowlist exemptions; the ratchet's
unused-capacity error; and the never-run inventory incl. the nested scriptless
`src/package.json` false-positive guard.

## Reproduce

```bash
node packages/scripts/lint-test-integrity.self-test.mjs   # 38 assertions
node packages/scripts/lint-test-integrity.mjs             # gate (exit 1 on violations)
node packages/scripts/lint-test-integrity.mjs --dry-run   # full inventory, exit 0
bun run lint                                              # runs the gate as CI does
```
