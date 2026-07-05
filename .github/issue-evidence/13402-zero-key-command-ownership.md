# 13402 zero-key command ownership evidence

## Scope

This artifact covers the #13402 slice implemented in this PR: a static
zero-key/keyless command ownership contract across:

- `.github/workflows/test.yml`
- `.github/workflows/scenario-pr.yml`
- `.github/workflows/keyless-harness-e2e.yml`
- `.github/workflows/ui-fixture-e2e.yml`

It does not change user-facing UI, model behavior, native/device behavior, or
runtime product behavior.

## Before

The repo had CI contracts for branch split, Turbo cache regime, Bun pinning,
merge-gate robustness, and full-matrix proof, but no dedicated static guard
that failed when the same zero-key/keyless test command was owned by multiple
workflows.

## After

`packages/scripts/ci-zero-key-command-ownership-contract.mjs` scans
zero-key/keyless workflow job blocks, extracts real suite commands, ignores
known shared setup commands, and fails if any non-setup command appears more
than once. `.github/workflows/test.yml` runs it in the existing `changes` job
beside the other static CI contracts.

The follow-up fix keeps static classifier/delegation jobs out of the command
census and normalizes leading environment assignments before comparing suite
commands, so an env-prefixed command cannot evade duplicate ownership. It also
marks whole-workflow owned surfaces such as `ui-fixture-e2e.yml` explicitly, so
their real suite commands are counted even when the job block itself does not
repeat the keyless marker from the workflow header.

## Verification

- `bun test packages/scripts/__tests__/ci-zero-key-command-ownership-contract.test.ts`
- `node packages/scripts/ci-zero-key-command-ownership-contract.mjs`
- `node_modules/.bin/biome check packages/scripts/ci-zero-key-command-ownership-contract.mjs packages/scripts/__tests__/ci-zero-key-command-ownership-contract.test.ts .github/workflows/test.yml .github/issue-evidence/13402-zero-key-command-ownership.md`
- `git diff --check`

## Evidence rows

- UI screenshots/video: N/A - CI static contract only; no rendered UI changed.
- Frontend/backend logs: N/A - no runtime code path changed.
- Real-LLM trajectories: N/A - no agent/model/prompt behavior changed.
- Audio/native/device artifacts: N/A - no audio/native/device behavior changed.
- Domain artifacts: N/A - no DB/memory/wallet/file-generation behavior changed.
