# Launch QA Integration Fixtures

This is the non-secret fixture contract for launch QA work that exercises real
external accounts, integrations, and wallet state. It is the durable repo-side
counterpart to Project 12 issue #14384.

The repository documents what must exist and what evidence must be captured. It
must not store live passwords, OAuth refresh tokens, recovery codes, private
keys, seed phrases, API keys, or funded-wallet signing material.

## Scope

Use this contract when verifying:

- Codex account and connector flows.
- Eliza Cloud sign-in, organization, agent, and API-key flows.
- Gmail / Google OAuth login and scope capture.
- Wallet inventory, funded-wallet state, direct crypto payment, and on-chain
  evidence flows.

This contract does not replace `PR_EVIDENCE.md`. It narrows that standard for
launch-QA account and wallet fixtures so reviewers can confirm which real
accounts were used without seeing the secrets.

## Secret Handling

- Store secrets only in the approved team password manager, secret manager, or
  cloud environment. GitHub issue/PR comments may name the vault item or secret
  handle, never the secret value.
- Use dedicated launch-QA accounts and wallets. Do not use a maintainer's
  personal inbox, personal wallet, or personal Codex account as a reusable test
  fixture.
- Use least-privilege scopes. If a flow needs a broad scope for product reasons,
  record that reason in the issue evidence.
- Rotate secrets after shared launch verification, after any screen recording
  where a secret might have appeared, and after access is granted to a new
  operator.
- Redact before posting evidence: emails may show the alias local part and
  domain class, API keys show prefix plus last four characters, wallet private
  keys and recovery phrases are never shown, and auth cookies/tokens are always
  fully hidden.

## Fixture Inventory

| Fixture | Required live asset | Required permissions / balance | Evidence to capture | Redaction rule |
| --- | --- | --- | --- | --- |
| Codex account | Dedicated launch-QA Codex-capable account, plus any connector authorization needed by the app flow | Enough access to complete sign-in and connector scope grants without touching production user data | Account handle, signed-in UI state, connector scope/permission screen, post-flow integration mark or connection row | Show account alias only; hide session cookies, auth headers, and refresh tokens |
| Eliza Cloud account | Dedicated launch-QA user in the launch-QA organization | Member/admin role appropriate to the tested flow; access to create/list agents and API keys when the scenario requires it | Organization id/name, user alias, agent id, API key prefix, before/after cloud status, backend logs for the route under test | Hide API key body, auth cookies, bearer tokens, and personal email recovery data |
| Gmail login | Dedicated Google test inbox and OAuth client/test-user setup | Only the Gmail/Google scopes required by the app connection being verified | OAuth consent screen, granted scopes, `/api/eliza-app/connections` or equivalent connection state, send/receive artifact if the test sends mail | Show mailbox alias; hide refresh/access tokens and any unrelated inbox content |
| Wallet fixture | Dedicated launch-QA wallet address controlled by the team | Enough funded balance on the tested network for the scenario, plus dust left after the run for before/after comparison | Wallet address, chain, token balances before and after, tx hash and explorer link for any transfer/payment, wallet UI screenshot, backend logs for wallet route calls | Public address and tx hash may be visible; never show seed phrase, private key, signing prompt secret material, or hardware-wallet recovery data |

## Funded Wallet Requirements

A wallet counts as a launch-QA funded wallet only when all of these are true:

1. It is dedicated to launch QA and not a maintainer's personal wallet.
2. The controlling key is recoverable by the team through an approved secret
   store or hardware-wallet custody process.
3. The issue or PR evidence names the network and public address.
4. The balance is sufficient for the planned test plus fees, with enough dust
   left to prove before/after state.
5. The evidence includes a before balance, after balance, and tx hash for any
   state-changing wallet or direct-payment flow.

For wallet inventory-only verification, a funded read-only address is enough if
the test does not sign or transfer. For direct crypto purchase, funding must be
on the exact network the route reports as enabled.

## Evidence Checklist

Each launch-QA issue or PR that uses these fixtures should include this table,
filled with either an artifact link or `N/A - <reason>`:

| Evidence row | Required proof |
| --- | --- |
| Fixture handles | Vault/secret-manager item names, account aliases, organization id, agent id, public wallet address |
| Account state before | Signed-out/signed-in status, existing connection list, wallet balance, or org credit balance before the run |
| Flow output | Screenshots/video/logs showing the real route or UI flow completing |
| Integration marks/scopes | Connection rows, granted OAuth scopes, API-key prefix, or app integration state after the run |
| Account state after | Updated connection list, wallet balance, org credit balance, or generated domain artifact |
| Redaction notes | What was hidden and why; confirm no secret values, cookies, private keys, or seed phrases are visible |

## Command Mapping

These commands do not provision the fixtures. They are the repo-side lanes that
operators can run once the live fixture handles and secrets are available.

```bash
# Worker e2e harness and route coverage notes
TEST_API_BASE_URL=https://api-staging.elizacloud.ai bun run --cwd packages/cloud/api test:e2e

# Connector route contracts, including Google/Gmail connection endpoints
TEST_API_BASE_URL=<target> bun test packages/cloud/api/test/e2e/group-f-connectors.test.ts

# Direct crypto payment contract up to the wallet-signing boundary
TEST_API_BASE_URL=<target> TEST_API_KEY=<redacted> bun test packages/cloud/api/test/e2e/group-m-direct-crypto.test.ts

# Full UI/native walkthrough evidence where wallet or connector surfaces are user-visible
bun run test:e2e:record
```

For app UI changes, also run the app audit command required by
`PR_EVIDENCE.md` and attach the manually reviewed desktop/mobile output to the
issue or PR.

When a command intentionally stops at a signing boundary or OAuth boundary, the
issue/PR evidence must name the live manual step that completed the real path.
Do not mark a fixture-dependent launch-QA card done with only mocked or
boundary-only tests.

## Operator Handoff Template

Paste this into the issue or PR when handing a launch-QA fixture run to another
operator:

```markdown
Fixture handles:
- Codex account:
- Eliza Cloud org/user/agent:
- Gmail test inbox:
- Wallet address and network:

Pre-run state:
- Cloud/org/API-key state:
- Connection/scopes state:
- Wallet balance:

Run commands / manual steps:
-

Post-run state:
- Integration marks/scopes:
- Wallet balance / tx hash:
- Logs/screenshots/video:

Redaction notes:
-
```
