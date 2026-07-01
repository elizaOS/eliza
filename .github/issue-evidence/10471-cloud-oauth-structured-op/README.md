# Issue #10471 - cloud OAuth structured op evidence

## Change

- Branch: `fix/10471-cloud-oauth-structured-op`
- Removed `OAUTH` operation inference from raw `message.content.text`.
- `OAUTH` now resolves the operation only from structured fields:
  `op`, `subaction`, `operation`, `action`, or legacy structured action metadata
  such as `OAUTH_CONNECT` / `OAUTH_REVOKE`.
- Updated the action description, parameter contract, and examples so the
  planner is told to provide structured `op` data instead of relying on prose.
- Added regression coverage proving English prose alone no longer routes and
  non-English text works when paired with structured params.

## Validation

- `focused-oauth-test.log`
  - PASS: 4 tests, including raw English `disconnect google` / `did it work?`
    rejection and structured non-English / legacy metadata acceptance.
- `cloud-shared-typecheck.log`
  - PASS: `bun run --cwd packages/cloud/shared typecheck`.
- `cloud-shared-lint.log`
  - PASS: `bun run --cwd packages/cloud/shared lint`.
- `install.log`
  - PASS: `bun install` after confirming the branch head matched
    `origin/develop`.
- `root-verify.log`
  - PASS: `bun run verify` (`Tasks: 474 successful, 474 total`, audits and
    dist-path checks passed).
- `git-diff-check.log`
  - PASS: staged branch diff whitespace check.
- `cloud-shared-test.log`
  - Attempted full package lane: OAuth tests passed within the run, but the
    package exited nonzero on an unrelated existing `x402-app-earnings.test.ts`
    module error: `Export named 'dbRead' not found in .../src/db/helpers.ts`.

## Evidence Notes

- Live model trajectory: N/A for this deterministic handler routing change; the
  planner contract is structured `op` extraction, and the handler no longer
  inspects prose for operation intent.
- Screenshots / screen recording / audio: N/A. No UI, visual, or audio surface
  changed.
