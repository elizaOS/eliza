# Nebius Clean Launch Prepared

Run: `robot-full-clean-1779556360`
State: `awaiting_nebius_cli_auth`
Payload: `s3://robot-rl-results-1779358330/robot-full-clean-1779556360/payload.tar.gz`
Payload bytes: `159760666`
Payload SHA256: `19d61cd72d34917444dfb55085f1d46a664f8794074934e806072066911c80f2`
Payload refreshed at: `2026-05-24T02:24:15Z`
Payload uploaded at: `2026-05-24T02:24:15Z`
Payload refreshed for: `post_auth_retry_report_audit_refresh`
Payload optimized: `True`
Launch hygiene ok: `True`
Resume command ready: `True`

## Blocker

Nebius CLI OAuth token expired; disk create blocks on browser authentication.

## Resume Command

`uv run eliza-robot-launch-prepared-nebius-clean-run --prepared-report evidence/nebius_full_training/clean_launch_prepared.json --secret-env /tmp/robot-full-clean-1779556360.env --identity ~/.ssh/id_ed25519 --ssh-timeout-seconds 900 --auth-timeout-seconds 20`

## Refreshed Payload Contents

- Production-aware Alberta end-to-end report generator.
- Backend and continual benchmark `validation_report.json` outputs.
- Manifest-preserving checkpoint video recording.
- Required Alberta end-to-end report artifacts in the production inventory.
- Stricter Alberta claim-support gates for robot-backend, obstacle-course, production, and video consistency claims.
- Backend comparison rollout-depth validation with production `--min-eval-mean-steps 20`.
- Optional SAC continual-learning baseline support and rendered Alberta/PPO/SAC obstacle-course demo evidence.
- Refreshed objective-completion audit and production-readiness documentation including Unitree R1.
- Objective-requirement proof table in `evidence/ALBERTA_END_TO_END_REPORT.{json,md}`.
- Explicit new-task adaptation and old-task retention summaries in benchmark evidence.
- Visual-review verdicts plus contact sheets for regenerated obstacle-course demo videos.
- Training-input, text-conditioning, curriculum, profile, and dataset readiness proof in the Alberta end-to-end report.
- Local Alberta checkpoint validation and shared `TextConditionedPolicy` inference proof for ASIMOV-1, Hiwonder AiNex, Unitree G1, Unitree H1, and Unitree R1.
- Robot backend method-delta matrix showing untrained baseline, Alberta, PPO, and deltas in the Alberta end-to-end report.
- Structured local validation summary with 123 passing tests and JUnit XML evidence.
- Comparison interpretation that separates robot-backend mean reward from continual obstacle-course adaptation/retention evidence.
- A stricter all-ready-profile Alberta checkpoint inference gate.
- Checkpoint-bound local Alberta policy videos for all five ready profiles, with frame review contact sheets and telemetry sidecars.
- Brax/MJX PPO artifact writer/config/manifest contract proof, explicitly marked as contract-only and not production training.
- Objective audit now explicitly records checkpoint-bound local policy video proof and Brax/MJX contract evidence.
- Alberta end-to-end report now links representative reviewed video/contact-sheet artifacts for both general action videos and checkpoint-bound Alberta videos.
- Alberta end-to-end report now verifies listed review contact sheets exist on disk.
- Checkpoint-bound Alberta video validation now requires task-signal telemetry: executed steps, finite reward/pose stats, and passing stability checks.
- Obstacle-course and SAC demo evidence now verifies demo video file presence, recorded byte counts, and visual-review contact-sheet presence.
- Alberta integration-surface validation now proves package modules, public exports, editable vendored dependency, CLI entrypoints, and implementation files are wired.
- Optional SAC comparison now exposes explicit Alberta-vs-SAC ACC, forgetting, and new-task-gain deltas plus a report-level advantage flag.
