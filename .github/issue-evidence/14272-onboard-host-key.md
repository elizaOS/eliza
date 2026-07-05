# Evidence: #14272 docker node re-onboard host-key pinning

## What changed

- `onboard-docker-node.ts` now loads the existing `docker_nodes` row before
  constructing `DockerSSHClient`.
- A stored `host_key_fingerprint` is passed into the SSH verifier before any
  root command runs, so a re-onboarded node with a different presented key hits
  the existing mismatch refusal path instead of TOFU.
- The upsert path preserves an established pin even if a callback somehow
  captured a new fingerprint; first-onboard and still-unpinned rows still persist
  the TOFU capture.

## Verification

Run from `/tmp/eliza-14272-host-key` on 2026-07-05:

```bash
bun test packages/scripts/cloud/admin/onboard-docker-node.test.ts
```

Result: 15 pass, 0 fail.

```bash
bunx @biomejs/biome check --write \
  packages/scripts/cloud/admin/onboard-docker-node.ts \
  packages/scripts/cloud/admin/onboard-docker-node.test.ts
```

Result: checked 2 files; formatter updated the touched script once, then the
focused test above passed.

```bash
git diff --check
```

Result: pass.

## Manual review notes

- Verified `buildOnboardSshConfig()` passes `existing.host_key_fingerprint` into
  the SSH config for re-onboard.
- Verified `hostKeyFingerprintForOnboardUpsert()` prefers the existing pin over
  any captured fingerprint and only persists a captured key for first-onboard or
  still-unpinned rows.
- The regression is covered with pure unit tests; no real SSH host was contacted.

## Evidence not applicable

- UI screenshots/video: N/A - admin script security fix only.
- Live LLM trajectories: N/A - no agent/model behavior changed.
- Backend logs/domain artifacts: N/A - no live production node was contacted;
  the test validates the pinning contract without making SSH or DB side effects.
