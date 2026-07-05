# #14051 CI real-failures helper

## Scope

Tier D helper for #14051: filter noisy cancelled/superseded check-run piles so
CI shepherds can see real completed failures.

## Change

- Added `packages/scripts/ci-real-failures.mjs`.
- Added `packages/scripts/ci-real-failures.self-test.mjs`.
- The helper supports:
  - `--repo owner/repo --pr <number>`: resolve the PR head SHA and inspect check
    runs through `gh api`.
  - `--repo owner/repo --sha <sha>`: inspect check runs for an exact commit.
  - `--input <json>`: deterministic offline input for tests and saved API
    payloads.
  - `--json`: machine-readable output.
- Filtering keeps only `status=completed` and `conclusion=failure`, excluding
  cancelled/canceled and explicit `superseded` runs.

## Verification

- `node packages/scripts/ci-real-failures.self-test.mjs`
  - Result: pass, `ci-real-failures self-test passed`
- `node --check packages/scripts/ci-real-failures.mjs && node --check packages/scripts/ci-real-failures.self-test.mjs`
  - Result: pass
- `git diff --check`
  - Result: pass
- `bunx @biomejs/biome check packages/scripts/ci-real-failures.mjs packages/scripts/ci-real-failures.self-test.mjs .github/issue-evidence/14051-ci-real-failures-helper.md --no-errors-on-unmatched`
  - Result: pass, `Checked 2 files`
- Offline canary input with one cancelled check and one real failure:
  - Command exited 1 and returned only the real failure in JSON.
- Live PR smoke:
  - `node packages/scripts/ci-real-failures.mjs --repo elizaOS/eliza --pr 14212 --json`
  - Result: `{"failures":[]}` and exit 0 because the live PR currently has no
    completed real failures.

## N/A

- This is a read-only CI triage helper. It does not change product UI, backend
  runtime behavior, models, prompts, or device lanes.
