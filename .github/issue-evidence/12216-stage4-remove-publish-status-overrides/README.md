# Stage 4 Remove Publish Status Overrides Evidence

Issue: #12321

PR scope:

- Remove the runtime `ELIZA_PUBLISH_STATUS_OVERRIDES` reader from the shared
  Eliza-1 model catalog.
- Keep the known qwen35 tiers (`eliza-1-9b`, `eliza-1-27b`,
  `eliza-1-27b-256k`) statically `pending` until their published bytes pass
  the Gemma text-architecture gate.
- Add a regression test that sets the retired env var and verifies the pending
  qwen tiers remain pending.

Verification:

```bash
git grep -n "ELIZA_PUBLISH_STATUS_OVERRIDES\\|readPublishStatusOverride" -- packages/shared/src plugins/plugin-local-inference/src packages/ui/src/services | head -100
# packages/shared/src/local-inference/catalog.test.ts only

git diff --check origin/develop..HEAD
# passed
```

Attempted focused Vitest:

```bash
bun run --cwd packages/shared test -- src/local-inference/catalog.test.ts
```

Result: failed before tests ran because this auxiliary worktree does not have a
usable `node_modules/vitest/vitest.mjs` install. The PR keeps the regression in
`packages/shared/src/local-inference/catalog.test.ts` for CI to execute.
