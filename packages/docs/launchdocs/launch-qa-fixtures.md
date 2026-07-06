# Launch QA fixture contract

Launch QA flows use owner-provided accounts, OAuth identities, and funded wallet
state that cannot be safely committed to the repository. This contract defines
the non-secret inventory, evidence packet, and redaction rules reviewers need
before marking fixture-dependent launch issues complete.

The goal is to make fixture ownership auditable without turning secrets,
personal inboxes, private keys, or production funds into test data.

## Principles

- Commit handles, not secrets. Repository docs may name the fixture class,
  environment, public identifiers, and owner, but never tokens, passwords,
  OAuth refresh tokens, private keys, recovery phrases, cookies, or raw inbox
  contents.
- Use staging or test-mode services for launch rehearsal. Production services
  are valid only for explicitly production-only verification, and the evidence
  must say why staging cannot prove the behavior.
- Prefer dedicated fixtures over personal accounts. If a personal account is
  temporarily unavoidable, the evidence packet must redact personal data and
  state when the fixture will be replaced.
- Keep money reversible and scoped. Wallet fixtures must use testnet funds,
  Stripe test mode, or a pre-approved low-value funded wallet with public
  before/after balance evidence and no private-key disclosure.
- A missing owner-provided fixture is a blocked launch item, not a passing test.

## Fixture registry fields

Each launch-QA fixture should be tracked in the issue or PR evidence packet with
these non-secret fields:

| Field | Required | Notes |
| --- | --- | --- |
| Fixture id | Yes | Stable slug, for example `cloud-staging-google-qa-1`. |
| Flow coverage | Yes | The flows this fixture proves: sign-in, integrations, wallet, billing, connector scopes. |
| Environment | Yes | `staging`, `preview`, `production`, local tunnel, device app, or PWA. |
| Owner | Yes | GitHub handle or team responsible for rotating and unlocking the fixture. |
| Secret location | Yes | Pointer only: 1Password vault, Cloudflare secret name, Stripe dashboard mode, Google test user list, etc. |
| Public identifiers | When safe | Redacted email shape, public wallet address, Stripe test customer id, Cloudflare Worker name. |
| State prerequisites | Yes | Required balance, scopes, tenant membership, feature flags, installed app version. |
| Reset procedure | Yes | How to return the fixture to a reusable state without deleting real user data. |
| Expiration / rotation | Yes | Date, credential rotation policy, or "single-use per run". |
| Evidence path | Yes | Link to the issue/PR comment carrying the inline evidence (see `PR_EVIDENCE.md`); never a committed evidence file. |

## Required launch fixtures

### Codex account fixture

Use this fixture for Codex connector, thread, subagent, and integration-mark
checks.

- Required owner state: a dedicated Codex account or org member that can create
  disposable threads and install the required connector/plugin set.
- Required evidence: before/after screenshots or API output showing the
  relevant integration mark, connector scope, created thread id, and cleanup
  result.
- Redact: access tokens, thread contents unrelated to the test, workspace paths
  outside the repo, and personal account metadata.
- Reset: archive or delete disposable test threads and revoke any temporary
  connector grants created during the run.

### Eliza Cloud staging account fixture

Use this fixture for staging login, dashboard, billing, API key, app tabs, and
agent provisioning checks.

- Required owner state: a staging account with known tenant membership, known
  billing state, and permission to create/revoke API keys and test agents.
- Required evidence: frontend console/network logs, backend request ids where
  available, before/after screenshots of account state, created API key redacted
  to prefix/suffix only, and cleanup confirmation for keys or agents.
- Redact: Steward cookies, JWTs, refresh tokens, full API keys, full email
  addresses unless the account is intentionally public test infrastructure.
- Reset: revoke generated API keys, delete disposable agents/apps, and record
  remaining billing/test-credit state.

### Gmail OAuth fixture

Use this fixture for Google sign-in and Gmail/Google connector scope checks.

- Required owner state: a Google test user that is allowed by the OAuth consent
  screen and has a safe inbox/calendar/contact corpus for launch QA.
- Required evidence: OAuth consent/account chooser screenshots with email
  redacted, callback/network status, final signed-in UI state, and granted scope
  list from the provider or app UI.
- Redact: full email address unless explicitly public, message bodies, contact
  data, OAuth codes, access tokens, refresh tokens, cookies, and any unrelated
  Google account metadata.
- Reset: revoke the app grant from the Google account security page when the run
  needs to prove first-consent behavior again.

### Funded wallet fixture

Use this fixture for wallet view, balance, send/receive, wallet-sign-in, and
payment-adjacent checks.

- Required owner state: a wallet public address on the target chain with either
  testnet funds or a pre-approved low-value mainnet budget. The private key,
  seed phrase, device unlock, and custody system must stay outside the repo.
- Required evidence: chain/network, public address, explorer balance before and
  after, transaction hash for funding or spend, app wallet UI screenshots, and
  cleanup/reconciliation note.
- Redact: private keys, seed phrases, hardware-wallet pairing secrets, bridge
  session tokens, and unrelated transaction history. Public addresses and tx
  hashes may be recorded when they are dedicated QA fixtures.
- Reset: return leftover value according to the owner runbook or record why the
  balance intentionally remains for later QA.

## Evidence packet

Every fixture-dependent launch run should add or link an evidence packet from
the relevant issue or PR. Evidence attaches **inline in the issue/PR itself**
per [`PR_EVIDENCE.md`](../../../PR_EVIDENCE.md): MP4 for video (GitHub renders
it inline), JPG over PNG for screenshots, long logs in a `<details>` block.
Do not commit evidence files to the repo — `.github/issue-evidence/` is
retired as a destination.

Minimum packet:

1. Fixture registry row for each account or wallet used.
2. Exact date, environment, build/version, and device/browser.
3. Flow checklist with `pass`, `fail`, or `blocked` per step.
4. Screenshots/video for the user-visible path.
5. Frontend console and network logs, with secrets redacted.
6. Backend request ids or logs when available.
7. Domain artifacts: API key id prefix/suffix, connector scope list, wallet
   public address/balance/tx hash, created agent/app id, or checkout/session id
   prefix as appropriate.
8. Cleanup/reset result.

Use `blocked` when the owner has not supplied a fixture, the fixture is locked,
or a live credential would be required. Do not substitute a mock account or an
empty wallet and call the flow verified.

## Redaction rules

- Keep enough shape for reviewers to confirm the artifact is real: first and
  last four characters for keys or ids, email domain when safe, public address
  and tx hash for dedicated QA wallets.
- Replace secrets with explicit markers such as `[redacted-refresh-token]`, not
  blank strings that make the artifact ambiguous.
- Record who performed the redaction and whether the unredacted source is stored
  in an approved private location.
- If an artifact cannot be redacted without losing meaning, store it outside git
  in the approved private evidence location and commit a representative summary.

## Sample issue update

```md
Fixture packet for #14384, run 2026-07-05:

- Fixture id: cloud-staging-google-qa-1
- Owner: @owner-handle
- Environment: staging.elizacloud.ai, iOS standalone PWA, build 2026.07.05.3
- Secret location: 1Password "Launch QA / Google staging user"; no secrets in git
- Public identifiers: q***@example.test, wallet 0x1234...beef
- Prerequisites: Google OAuth test user allowed; wallet holds 0.02 test ETH
- Evidence: inline below (screenshots + <details> logs) per PR_EVIDENCE.md
- Result: pass; API key revoked, disposable agent deleted, wallet balance reconciled
```

## Closing #14384

This repo contract is only the non-secret half. The issue is complete when an
owner also supplies real fixture identities and evidence showing the Codex,
Eliza Cloud, Gmail, and wallet flows were exercised with those fixtures.
