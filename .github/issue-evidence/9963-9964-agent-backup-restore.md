# Issues #9963 and #9964 — Agent Backup, Restore, Upgrade Rollback

## Scope

- Local full-agent backup/restore now captures the PGlite/Postgres state,
  media store, vault files, character/config, and selected state-dir files with
  a hash manifest and tamper detection.
- The local agent API exposes backup list/create/restore and full snapshot
  export/restore endpoints.
- LifeOps installs one local auto-backup scheduled task and dispatches through
  the existing scheduled-task runner.
- Settings exposes Backup & Reset controls for local backup creation and
  restore.
- Shared dialog foreground colors now keep backup/restore modal titles and
  close controls readable on the app's light dialog surface.
- Cloud backup metadata/state storage encrypts backup state data, stores large
  payloads out of row JSON, and avoids lossy incrementals when a full-agent
  manifest is present.
- Cloud upgrade/downgrade now captures a pre-upgrade snapshot, gates cutover on
  runtime health, persists the previous image digest/image, and restores the
  pre-upgrade snapshot before rollback cutover.

## Verification

- Post-rebase sync completed with `bun install`.
  Artifact: `9963-9964-post-rebase-bun-install.log`.
- `bun run verify` passed after the final rebase:
  `476 successful, 476 total`; build/typecheck audit passed; Turbo build-deps
  audit passed; secret-leak audit passed; scripts audit passed; dist-path
  typecheck checked 28 consumer configs.
  Artifact: `9963-9964-root-verify.log`.
- Local backup service tests passed:
  `packages/agent/src/services/agent-backup.test.ts` — 3 tests covering full
  manifest restore, tamper refusal, and encrypted local backup file restore.
  Artifact: `9963-agent-local-backup-vitest.log`.
- Cloud scheduled backup E2E passed:
  `packages/test/cloud-e2e/tests/scheduled-backup.spec.ts` — 3 tests including
  manual snapshot restore through the cloud restore endpoint.
  Artifact: `9963-9964-cloud-e2e-scheduled-backup.log`.
- Cloud backup/rollback focused tests passed:
  111 tests across `agent-backup-diff`, `agent-sandboxes`,
  `provisioning-jobs-agent-downgrade`, `provisioning-job-types`, and
  `eliza-sandbox`.
  Artifact: `9964-cloud-backup-downgrade-tests.log`.
- Cloud API compatibility checks passed for the Worker-side `@elizaos/core`
  stub used by the E2E local stack.
  Artifacts: `9963-9964-cloud-api-typecheck.log`,
  `9963-9964-cloud-api-lint.log`.
- Focused post-rebase lint/typecheck checks passed for the UI and plugin
  packages touched while satisfying the final root verify run.
  Artifacts: `9963-9964-ui-lint.log`,
  `9963-9964-plugin-edge-tts-typecheck.log`,
  `9963-9964-plugin-embeddings-typecheck.log`.
- Focused latest-base UI typecheck passed after typing the new
  `startup-phase-hydrate.voice-control` test listener as a DOM `EventListener`
  while preserving the mock assertions.
  Artifacts: `9963-9964-ui-typecheck-latest-base.log`,
  `9963-9964-ui-voice-control-test.log`.
- Final-base app lint and capacitor bridge build checks passed after resolving
  the last develop rebase formatting/build conflicts.
  Artifacts: `9963-9964-app-lint.log`,
  `9963-9964-plugin-capacitor-bridge-build.log`.
- Latest-base compatibility checks passed after resolving upstream rebase
  blockers in package-local configuration/source: agent import ordering and
  Polymarket Node type availability.
  Artifacts: `9963-9964-agent-lint-latest-base.log`,
  `9963-9964-plugin-polymarket-typecheck-latest-base.log`.
- App visual audit passed on the previous synced base:
  `bun run --cwd packages/app audit:app` — 369 passed. After the final rebase,
  the full audit wrapper could not own default port 2138 because another local
  worktree was already serving it, so the touched `builtin-settings` audit was
  rerun on alternate ports: 4 passed, with broken=0 and needs-work=0. Settings
  screenshots were manually reviewed for desktop, mobile portrait, mobile
  landscape, and iPad portrait.
  Artifacts: `9963-9964-app-audit.log`,
  `9963-9964-settings-audit-latest-base.log`.
- Backup modal UI smoke passed and was recorded after the final rebase:
  `settings-sections-interactions.spec.ts --grep "backup & reset settings"` —
  1 passed.
  Artifacts: `9963-settings-backup-modal-record.log`,
  `9963-settings-backup-modal.png`, `9963-settings-backup-modal.webm`,
  `9963-settings-backup-modal-trace.zip`.
- `git diff --check` passed after verification.

## Screenshots And Video

- `9963-settings-desktop-landscape.png`
- `9963-settings-mobile-portrait.png`
- `9963-settings-mobile-landscape.png`
- `9963-settings-ipad-portrait.png`
- `9963-settings-backup-modal.png`
- `9963-settings-backup-modal.webm`

## Known Evidence Gap

Live-model recall trajectory capture for backup -> wipe -> restore was not run.
Checked without printing secret values: `CEREBRAS_API_KEY` is configured, while
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
`GROQ_API_KEY`, `OPENROUTER_API_KEY`, and `XAI_API_KEY` are missing. I did not
find an existing scenario-runner scenario that exercises this restored-memory
recall path end to end, so the deterministic runtime, cloud E2E, UI, and
manually reviewed artifact evidence above are the validation coverage attached
here.
