# Issue #11607 evidence - arm-apps-daemon container SSH key

## Change

- `.github/workflows/arm-apps-daemon.yml` now resolves container SSH key material from `CONTAINERS_SSH_KEY` or the same target deploy key, normalizes it to the base64 format consumed by `docker-ssh.ts`, forwards it through `ssh-action`, and upserts `CONTAINERS_SSH_KEY` into `/opt/eliza/cloud/.env.local`.
- `packages/scripts/cloud/admin/arm-apps-daemon.mjs` keeps local arming behavior in parity by supporting `--node-ssh-key-base64` in addition to `--node-ssh-key-path`.
- `packages/scripts/cloud/admin/daemons/arm-apps-daemon-workflow.test.ts` guards the workflow wiring that regressed.

## Verification

```bash
bun install
```

Result: passed, no dependency changes.

```bash
bun test packages/scripts/cloud/admin/daemons/arm-apps-daemon-workflow.test.ts packages/scripts/cloud/admin/daemons/provisioning-worker-env-reconcile.test.ts
```

Result: 13 pass, 0 fail.

```bash
bunx @biomejs/biome check .github/workflows/arm-apps-daemon.yml packages/scripts/cloud/admin/arm-apps-daemon.mjs packages/scripts/cloud/admin/daemons/arm-apps-daemon-workflow.test.ts
```

Result: passed.

```bash
actionlint .github/workflows/arm-apps-daemon.yml
```

Result: passed.

```bash
git diff --check
```

Result: passed.

```bash
bun run verify
```

Result: failed before package typecheck/lint on the repo-wide type-safety ratchet. The exceeded counts are unrelated to this workflow/admin-script change:

- `as unknown as`: 77 current > 76 baseline
- ``?? 0`` in core/agent/app-core: 376 current > 375 baseline

The command also reported that the non-null assertion baseline can shrink from 518 to 515.

## N/A

- UI screenshots/video: N/A - workflow/admin script only.
- Real-LLM trajectories: N/A - no agent/action/prompt/model behavior changed.
- Backend/frontend logs from staging run: N/A - this change is a GitHub Actions wiring fix and was verified with static workflow guards plus `actionlint`; it has not been manually dispatched against production secrets from this local environment.
