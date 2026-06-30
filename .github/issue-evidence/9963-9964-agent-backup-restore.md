# Issues #9963 and #9964 — Agent Backup, Restore, Upgrade Rollback

## Scope

- Local full-agent backup/restore captures the runtime database, media store,
  vault files, character/config, and selected state-dir files with a hash
  manifest and tamper detection.
- Live PGlite backup now prefers `dumpDataDir("gzip")` from the running raw
  connection and restores through PGlite `loadDataDir`; the file-set fallback
  excludes volatile server files such as `postmaster.pid`, `postmaster.opts`,
  `eliza-pglite.lock`, root `.s.PGSQL.*`, and `pg_stat_tmp/*`.
- The local agent API exposes backup list/create/restore and full snapshot
  export/restore endpoints.
- LifeOps installs one local auto-backup scheduled task and dispatches through
  the existing scheduled-task runner.
- Settings exposes Backup & Reset controls for local backup creation and
  restore.
- First-run onboarding now checks for local backups before runtime selection and
  offers restore/start-fresh choices.
- Shared chat/overlay UI was adjusted so first-run restore choices do not get
  visually obscured by the home widget and selected choices are exposed to
  assistive tech without adding noisy visible echo text.
- Cloud backup metadata/state storage encrypts backup state data, stores large
  payloads out of row JSON, and avoids lossy incrementals when a full-agent
  manifest is present.
- Cloud upgrade/downgrade captures a pre-upgrade snapshot, gates cutover on
  runtime health, persists the previous image digest/image, and restores the
  pre-upgrade snapshot before rollback cutover.

## Verification

- Post-rebase `bun install` passed after syncing to current `origin/develop`
  with no dependency changes.
  Artifact: `9963-9964-post-rebase-bun-install.log`.
- `bun run verify` passed after rebasing onto current `origin/develop`:
  `476 successful, 476 total`; build/typecheck audit passed; Turbo build-deps
  audit passed; secret-leak audit passed; scripts audit passed; dist-path
  typecheck checked 28 consumer configs.
  Artifact: `9963-9964-root-verify.log`.
- `git diff --check` passed after trimming generated-log trailing whitespace.
- Type-safety ratchet passed on the rebased branch after replacing ten
  `agent-export` manifest defaults with a typed shared empty collection:
  `?? []` remained at the checked-in `588 / 588` limit.
  Artifact: `9963-9964-type-safety-ratchet.log`.
- Local backup service tests passed:
  `packages/agent/src/services/agent-backup.test.ts` — 4 tests covering full
  manifest restore, tamper refusal, encrypted local backup file restore, and
  live PGlite `dumpDataDir` capture.
  Artifact: `9963-agent-local-backup-vitest.log`.
- Agent export roundtrip tests passed after the ratchet cleanup:
  `packages/agent/src/services/agent-export.roundtrip.test.ts` — 10 passed.
  Artifact: `9963-agent-export-roundtrip-vitest.log`.
- Focused agent checks passed after the final backup-service change.
  Artifacts: `9963-9964-agent-typecheck.log`,
  `9963-9964-agent-lint.log`.
- Post-rebase package checks passed for current-develop blockers exposed by the
  final verify: UI lint, Electrobun lint, Cloud API lint, Facewear lint, Feed
  typecheck, and Hyperliquid typecheck.
  Artifacts: `9963-9964-ui-lint-first-run-restore.log`,
  `9963-9964-electrobun-lint.log`,
  `9963-9964-cloud-api-lint.log`,
  `9963-9964-plugin-facewear-lint.log`,
  `9963-9964-plugin-feed-typecheck.log`,
  `9963-9964-plugin-hyperliquid-typecheck.log`.
- Cloud scheduled backup E2E passed:
  `packages/test/cloud-e2e/tests/scheduled-backup.spec.ts` — 3 tests including
  manual snapshot restore through the cloud restore endpoint.
  Artifact: `9963-9964-cloud-e2e-scheduled-backup.log`.
- Cloud backup/rollback focused tests passed:
  111 tests across `agent-backup-diff`, `agent-sandboxes`,
  `provisioning-jobs-agent-downgrade`, `provisioning-job-types`, and
  `eliza-sandbox`.
  Artifact: `9964-cloud-backup-downgrade-tests.log`.
- First-run restore smoke passed directly:
  `test/ui-smoke/first-run-startup.spec.ts` — 2 tests passed, including the
  backup restore prompt and restore POST body assertion.
  Artifact: `9963-first-run-restore-smoke-direct.log`.
- First-run restore recording passed:
  `fresh first-run offers to restore an existing local backup before onboarding`
  — 1 passed with screenshot and video manually reviewed.
  Artifacts: `9963-first-run-restore-record.log`,
  `9963-first-run-restore-prompt.png`,
  `9963-first-run-restore-prompt.webm`.
- App visual audit was rerun after the first-run UI changes:
  `bun run --cwd packages/app audit:app` produced 367 passed rows and 2
  unrelated context-closed failures on `plugin-health-tui desktop-landscape` and
  `plugin-facewear-tui desktop-landscape`. The generated audit summaries for the
  run reported `broken=0` and `needs-work=0`.
  Artifact: `9963-9964-app-audit-first-run-restore.log`.
- Backup modal UI smoke passed and was recorded after the final rebase:
  `settings-sections-interactions.spec.ts --grep "backup & reset settings"` —
  1 passed.
  Artifacts: `9963-settings-backup-modal-record.log`,
  `9963-settings-backup-modal.png`, `9963-settings-backup-modal.webm`,
  `9963-settings-backup-modal-trace.zip`.
- Restore-prep evidence created a real encrypted local backup from a PGlite
  runtime, wiped the PGlite/media/vault state, restored it, and confirmed the
  restored backup used `database=pglite-dump` with one media file and three
  vault files. A post-restore `find` check found no volatile PGlite server
  files.
  Artifacts: `9963-live-restore-prep.ts`,
  `9963-live-restore-prep.log`,
  `9963-live-restore-prep-summary.json`.
- Restored-state scenario passed through scenario-runner using the restored
  PGlite directory:
  `backup.restore-recall` — 1 passed, response text exactly
  `silver comet orchid`; native trajectory shows the restored durable fact in
  the prompt and the final response.
  Artifacts: `9963-deterministic-restore-scenario-report.json`,
  `9963-deterministic-restore-scenario.log`,
  `9963-deterministic-restore-native.jsonl`,
  `9963-deterministic-restore-run/`.
- Live-provider attempt against the available configured Cerebras key reached
  the restored-state prompt and showed the restored fact in live model input,
  but all available Cerebras response-handler completions returned empty output,
  so the live run did not satisfy the recall assertion. The restored-state
  deterministic run above is the passing end-to-end scenario evidence; the live
  artifacts document the provider behavior without treating it as a pass.
  Artifacts: `9963-live-restore-scenario.log`,
  `9963-live-restore-scenario-report.json`,
  `9963-live-restore-run/`,
  `9963-live-restore-run-viewer/`,
  `9963-live-restore-native.jsonl`.

## Screenshots And Video

- `9963-settings-desktop-landscape.png`
- `9963-settings-mobile-portrait.png`
- `9963-settings-mobile-landscape.png`
- `9963-settings-ipad-portrait.png`
- `9963-settings-backup-modal.png`
- `9963-settings-backup-modal.webm`
- `9963-first-run-restore-prompt.png`
- `9963-first-run-restore-prompt.webm`
