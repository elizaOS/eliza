# Evidence: #14262 ReDoS SQL and email guards

## What changed

- Moved the prompt-reachable `DATABASE` action read-only guard onto the shared
  linear SQL sanitizer path now used by the dashboard database API guard.
- Extracted the action read-only guard into a lightweight security helper so its
  ReDoS behavior is covered without importing the full action/runtime graph.
- Replaced remaining simple email-regex validators in cloud-shared and
  plugin-form with scan-based `basicEmailValid` helpers.

## Verification

Run from `/private/tmp/codex-14276-rebase` on 2026-07-05 after rebasing onto
`origin/develop` at `b44d59ad62`:

```bash
bun test \
  packages/agent/src/api/database.strip-comments.test.ts \
  packages/agent/src/actions/database-readonly.test.ts \
  packages/agent/src/actions/database.readonly-redos.test.ts \
  plugins/plugin-form/src/email.test.ts \
  packages/cloud/shared/src/lib/utils/email-validation.test.ts
```

Result: 28 pass, 0 fail.

```bash
bunx @biomejs/biome check \
  packages/agent/src/security/sql-readonly-guard.ts \
  packages/agent/src/actions/database.ts \
  packages/agent/src/actions/database-readonly.test.ts \
  packages/agent/src/actions/database.readonly-redos.test.ts \
  packages/agent/src/api/database.strip-comments.test.ts \
  packages/cloud/shared/src/lib/utils/email-validation.ts \
  packages/cloud/shared/src/lib/utils/email-validation.test.ts \
  packages/cloud/shared/src/lib/utils/phone-normalization.ts \
  packages/cloud/shared/src/lib/utils/phone-normalization.test.ts \
  plugins/plugin-form/src/email.ts \
  plugins/plugin-form/src/email.test.ts \
  plugins/plugin-form/src/builtins.ts \
  plugins/plugin-form/src/validation.ts
```

Result: checked touched files, no fixes applied.

```bash
git diff --check
```

Result: pass.

Additional attempted checks:

```bash
bun run --cwd packages/agent typecheck
bun run --cwd plugins/plugin-form typecheck
bun run --cwd packages/cloud/shared typecheck
```

Result: blocked in the sparse worktree by missing workspace/package dependency
resolution, including `@elizaos/auth`, `@elizaos/tui`, `@elizaos/contracts`,
`@elizaos/core`, `@elizaos/security/kms`, `ai`, `jose`, and other packages not
materialized in this sparse checkout. These failures occurred outside the
touched pure guard/helper files.

## Manual review notes

- Reviewed the SQL tests for the exact legacy semantics: block comments remove
  with empty replacement, `DE/* */LETE` collapses to `DELETE`, closed
  dollar-quoted strings are ignored, unterminated dollar quotes remain visible
  to the guard, and PostgreSQL unicode-escaped identifiers (`U&"..."`) are
  still rejected after extracting the guard into the helper.
- Reviewed the email tests for equivalence against the previous simple regex on
  safe cases and linear-time rejection on adversarial dotted-domain inputs.
- Attempted broader `plugins/plugin-form/src/service-hardening.test.ts` and
  `packages/cloud/shared/src/lib/utils/phone-normalization.test.ts` in the sparse
  worktree after generating core keyword data. They were blocked by Bun
  workspace-resolution issues from package-local sparse `node_modules` symlinks,
  not by assertion failures. The edited pure validators are covered above.

## Evidence not applicable

- UI screenshots/video: N/A - backend/security validation only; no UI surface
  changed.
- Live LLM trajectory: N/A - no prompt, model handler, provider, evaluator, or
  model-output behavior changed. The vulnerable action guard is covered by a
  deterministic regression test using model-shaped SQL input.
- Server logs/domain artifacts: N/A - no request handler was executed against a
  live server and no persisted domain artifact is produced by these pure guards.
