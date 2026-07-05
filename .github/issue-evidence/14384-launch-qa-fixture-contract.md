# #14384 launch-QA fixture contract evidence

This branch adds `packages/docs/launchdocs/launch-qa-fixtures.md`, a non-secret
contract for the launch-QA account and wallet fixtures required by #14384.

## What this proves

- The repository now has a durable place to record fixture ownership, public
  identifiers, reset procedures, and evidence requirements without committing
  passwords, OAuth tokens, cookies, private keys, recovery phrases, or wallet
  custody material.
- The contract covers the fixture classes named in #14384: Codex accounts,
  Eliza Cloud staging accounts, Gmail/Google OAuth users, and funded wallets.
- The evidence packet explicitly requires before/after account or wallet state,
  integration marks/scopes, screenshots/video, frontend logs, backend request
  ids when available, domain artifacts, and cleanup results.
- The redaction rules distinguish safe public identifiers from secrets, so QA can
  publish human-verifiable proof without leaking credentials.

## What remains outside the repo

- Owners still need to provision or identify the actual integration accounts and
  funded wallet.
- Owners still need to provide the private secret locations, unlock access, and
  live before/after evidence for each launch run.
- A fixture-dependent flow remains `blocked`, not `pass`, until that real
  owner-provided account or wallet evidence is attached.

## Verification

- `node packages/scripts/launch-qa/check-docs.mjs --scope=launchdocs --json`
  - pass, 2 launchdocs checked
- `bun run --cwd packages/docs test`
  - pass, 15/15 docs tests
- `git diff --check`
  - pass

No app, backend, database, model, wallet, or OAuth runtime was exercised by this
repo-only documentation slice.
