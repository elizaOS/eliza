# CI review receipt: PR #16633 bootstrap

Date: 2026-07-18
Branch: `sol/proposal-unblock-agent-review`
Base: `develop`
Scope: deterministic, no-cost bootstrap for the retired automatic Anthropic checks

## Reviewed policy

- `.github/workflows/claude-code-review.yml` preserves the exact `claude-review` job/check name and deterministically succeeds without checkout, PR code execution, secrets, or an external review action.
- `.github/workflows/claude-security-review.yml` preserves the exact `security` job/check name and deterministically succeeds without checkout, PR code execution, secrets, or an external review action.
- Both stubs run for `ready_for_review` and `synchronize`, so this bootstrap PR can satisfy the old base-trusted gate after leaving draft.
- `scripts/security/security-advisory-gate.mjs` remains fail-closed on the deterministic `gitleaks` check only.
- PR #16634 is identified as the proposed agent-review replacement. This receipt does not activate that replacement and does not approve a ruleset mutation.
- No merge or auto-merge was requested.

## Deterministic validation

### Focused tests

Command:

```sh
node --test scripts/security/security-advisory-gate.test.mjs scripts/security/advisory-workflow-stubs.test.mjs
```

Result: **12 tests passed, 0 failed**.

Coverage includes:

- both workflow files have the exact required job IDs;
- neither workflow references `anthropics/`, `ANTHROPIC_API_KEY`, or `actions/checkout`;
- both workflows include `ready_for_review` and `synchronize` triggers;
- the gate waits for missing/nonterminal `gitleaks`;
- the gate fails non-success terminal `gitleaks` outcomes;
- failed `claude-review` and `security` outcomes do not affect a successful `gitleaks` result.

### Five canaries

Command:

```sh
for scenario in bypass protected waiting success failure; do
  CANARY_SCENARIO="$scenario" node scripts/security/security-advisory-gate.mjs
done
```

Result: **bypass, protected, waiting, success, and failure all passed**.

### Workflow syntax and lint

- `actionlint v1.7.12` passed both modified workflow files using `.github/actionlint.yaml`.
- PyYAML `BaseLoader` parsed both files and confirmed the exact top-level job IDs.
- `node --check` passed the gate and both focused test files.

### Diff integrity

Command: `git diff --check`

Result: **passed**.

## Review conclusion

The bootstrap removes automatic Anthropic API cost and availability from both legacy checks while retaining the check names needed by the old gate. Deterministic secret scanning remains enforced through `gitleaks`. Ready for maintainer review, not merge.

[sol-orch]
