# Security advisory merge gate proposal

`Security Advisory Gate` is a stable required context proposed for the `develop` ruleset. It passes immediately for ordinary pull requests. It waits, fail closed, for the existing `security` and `claude-review` advisory jobs only when a pull request:

- has `security`, `SECURITY ISSUE`, `auth`, `money-path`, or `payment integration` label, or
- changes Security Review-eligible code/config files in authentication, OAuth, security, payment, billing, wallet, contract, migration, secret/credential/token, or GitHub workflow/action paths.

Only `success` is accepted, and both advisory workflows now fail when their review action is skipped because credentials are absent or when the action errors. A failed, cancelled, neutral, or skipped advisory fails the gate. A missing or running advisory remains pending until the 20-minute poll timeout, then fails. This narrowly closes the auto-merge race without making either advisory globally required. The security advisory is made available on every PR head and reruns on label and draft-ready transitions so a label-only decision cannot wedge on an absent check; ordinary PRs do not wait for it.

## No label escape hatch

No PR label bypasses this gate. Labels can be applied by users with triage access and are not proof of maintainer authorization. If an advisory service is unavailable, a maintainer must inspect the evidence and merge manually under the repository's normal administrative controls.

## Activation

The workflow proposal must merge before adding its context. Then update ruleset `18901247` (`protect develop required PR gate`) to include the GitHub Actions context `Security Advisory Gate` (`integration_id: 15368`). Do not activate the context before the workflow exists, or all PRs will wedge.

## Dry-run

Each state is deterministic and available under `workflow_dispatch`: `bypass`, `protected`, `waiting`, `success`, and `failure`. Locally:

```sh
for state in bypass protected waiting success failure; do
  CANARY_SCENARIO=$state node scripts/security/security-advisory-gate.mjs
done
```
