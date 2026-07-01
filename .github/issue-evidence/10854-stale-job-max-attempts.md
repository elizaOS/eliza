# #10854 stale job max_attempts evidence

## Scenario

The regression test seeds two `agent_message` jobs that are already stale:

- `max_attempts = 1`, `attempts = 0`, `status = in_progress`
- `max_attempts = 3`, `attempts = 0`, `status = in_progress`

`jobsRepository.recoverStaleJobs({ type: "agent_message", staleThresholdMs: 5 * 60 * 1000, maxAttempts: 3 })`
then runs against an in-process PGlite `jobs` table.

## Expected proof

- The single-attempt job becomes `failed`, `attempts = 1`.
- The retryable job becomes `pending`, `attempts = 1`.
- The recovered count is `1`, because only the retryable job is re-queued.

This proves recovery uses each row's `max_attempts` instead of the caller-wide fallback.

## Validation

```bash
bun test packages/cloud/shared/src/db/repositories/__tests__/jobs-recovery.test.ts packages/cloud/shared/src/lib/services/provisioning-jobs-stale-threshold.test.ts
bun run biome check packages/cloud/shared/src/db/repositories/jobs.ts packages/cloud/shared/src/lib/services/provisioning-jobs.ts packages/cloud/shared/src/db/repositories/__tests__/jobs-recovery.test.ts
bun run --cwd packages/cloud/shared typecheck
```

All passed locally on the exact PR branch.

## N/A artifacts

- Screenshots/video: N/A, backend repository retry-state fix only.
- Frontend console/network logs: N/A, no frontend path.
- Real-LLM trajectories: N/A, no model/action/prompt path.
