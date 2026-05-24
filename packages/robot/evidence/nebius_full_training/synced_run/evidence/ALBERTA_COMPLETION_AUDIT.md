# Alberta Completion Audit

Generated: 2026-05-23T09:49:58Z

This audit maps the requested end-to-end robot-training objectives to the
current evidence. It is intentionally strict: smoke evidence proves wiring and
regression coverage, while production learning claims remain pending until the
active Nebius H200 run uploads completed artifacts.

## Current Nebius Run

| field | value |
|---|---|
| run_id | `robot-full-1779504720` |
| instance_id | `computeinstance-e00x4sqmx07qwehxrc` |
| disk_id | `computedisk-e00te9qnayns1bsz15` |
| state | `STOPPED` |
| object prefix | `s3://robot-rl-results-1779358330/robot-full-1779504720/` |
| completed uploaded logs | `00_local_preflight.log` |
| last known stage | `10_nebius_train_alberta` |
| failure marker | absent |
| success marker | absent |

The VM is now `STOPPED` after exceeding the 12-hour hard cap, but object
storage never advanced past local preflight. Direct S3 listing shows no
uploaded stage-10 log or checkpoint; the newest run-prefix objects remain
preflight-era uploads from 2026-05-22 20:02:33 UTC. The stopped run is retained
as failed/incomplete evidence; a clean production relaunch is now the path to
completion.

The current object prefix has also been synced into
`evidence/nebius_full_training/synced_run` and checked with
`eliza-robot-validate-nebius-full-training --allow-incomplete --no-deep-validators`.
That report is intentionally `not-ready`: only `00_local_preflight` and the
preflight-era videos are present; the production stages and checkpoints have
not uploaded yet.

The repeatable one-shot monitor is now
`eliza-robot-monitor-nebius-full-training`. It writes
`evidence/nebius_full_training/synced_run/monitor_status.json` and
`monitor_summary.md`; the latest monitor state is `running`, with 1/6 stages
complete and `continue_polling` as the next action.

The guarded finalization command is now
`eliza-robot-finalize-nebius-full-training`. It writes
`finalization_report.json` and `finalization_summary.md`, and currently refuses
completion with `not-finalized` because the production gates and full artifact
inventory are still missing.

The artifact-driven final comparison report command is
`eliza-robot-generate-nebius-training-report`. It writes
`training_comparison_report.json` and `training_comparison_report.md`; the
current partial report is `not-complete` and leaves production Alberta/PPO,
continual-learning, and Brax/MJX metrics as `missing` until the H200 artifacts
arrive. The report now includes an explicit Alberta / Stable-Baselines3 PPO /
Brax-MJX PPO method matrix, reward deltas, obstacle-course ACC deltas,
forgetting deltas, and machine-readable completion-requirement gates so the
final comparison cannot rely on prose-only claims. It also surfaces validation
gate details from `validation_report.json`: backend delta/winner checks,
benchmark delta gates, Alberta checkpoint and ASIMOV-1 production checkpoint
checks, training-input checks, and video action-progress thresholds.
It now also includes a dedicated `multi_robot_video_manifest` section with
per-profile expected/present/missing video counts and combined-action video
presence, so all-robot video evidence can be reviewed directly from the final
report. Production video closeout now has a separate
`production_policy_videos` gate, which requires the video manifest and target
profile entry to point at the trained Alberta checkpoint instead of accepting
preflight clips as production-policy evidence.
It now also includes an `instance_launch_hygiene` validation gate and completion
requirements for no inline object-storage credentials, use of the repo-owned
stage runner, use of `NEBIUS_TRAINING_S3_URI`, and heartbeat/status upload
coverage during long stages.
It now also includes a `stage_status` validation gate and completion
requirements for `runner_status.json` plus every per-stage status JSON reaching
`state=complete` with return code zero, timestamps, and heartbeat evidence.

The canonical one-command closeout is now
`eliza-robot-closeout-nebius-full-training`. It syncs, monitors, finalizes, and
generates the artifact-driven report in one pass. The current closeout state is
`running`; it exits `0` only when all production gates are complete. It also
writes `artifact_inventory.json` and `artifact_inventory.md`; the current
inventory has 53/88 required artifacts present. Required artifacts now include
the full-training `training_inputs_report.json`, so final closeout cannot omit
task/text-conditioning/dataset readiness evidence, `runtime_watch_history.jsonl`,
so repeated polling leaves an auditable runtime history, benchmark Markdown and
plot outputs for `joint_reach` and `obstacle_course`, and the final Markdown
training comparison summary. Inventory also requires `agent_videos/manifest.json`
for all-robot video evidence, the per-profile MP4s and contact sheets for
Hiwonder AiNex, Unitree G1, Unitree H1, and Unitree R1, the ASIMOV production
MP4s themselves, ASIMOV production video contact sheets for
stand/walk/turn/combined-action manual review, plus the monitor, validation,
and finalization Markdown summaries for human review, while intentionally not requiring
`closeout_status.json` because closeout writes that file after inventory
generation. Closeout sync now mirrors the Nebius prefix with `--delete` while
preserving only local runtime-watch files, so stale local evidence cannot
satisfy the production inventory.
Inventory now also requires `instance_launch_hygiene.json`, and the redacted
active instance launch-hygiene report is present but fails its checks for this
run.
Inventory now also requires `status/runner_status.json` and every
`status/<stage>.json`; the current partial inventory has 53/88 required
artifacts present, with all eight runner/stage status artifacts missing from
the active run prefix because the active launch predates the repo-owned runner.

The post-completion cleanup plan is guarded by
`eliza-robot-plan-nebius-training-cleanup`. It currently refuses cleanup because
closeout, finalization, artifact inventory, production validation, and the final
training-comparison report are not complete, and holds the VM/disk/upload-key
cleanup commands until the production artifacts are archived and validated. It
now reports exact failed gates, plus separate `complete` and `override_used`
fields so an explicit early-cleanup override cannot be mistaken for clean
completion.

The runtime watchdog is
`eliza-robot-watch-nebius-training-runtime`. The latest runtime report says
`inspect_or_terminate_cost_cap_exceeded`: about 14.08 hours elapsed, `stale=true`,
and roughly 2.08 hours past the 12-hour launch hard cap. It now appends
compact snapshots to `runtime_watch_history.jsonl` so the polling record is
preserved across turns.
The relaunch-readiness command is now
`eliza-robot-plan-nebius-training-relaunch`. The latest plan confirms the
regenerated preflight bundle and safe launch template are ready and returns
`ready_to_launch_clean_run`; the stale hard-cap-exceeded H200 instance was
stopped before relaunch. A redacted instance-state report is stored at
`evidence/nebius_full_training/instance_state_redacted.json`.
The clean relaunch payload has been packaged and uploaded to
`s3://robot-rl-results-1779358330/robot-full-clean-1779556360/payload.tar.gz`
with a launch-hygiene-clean instance spec. The payload was reduced from the
initial 1.8 GB archive to about 57 MB by excluding local environments, caches,
stale Nebius sync artifacts, checkpoints, and large vendor/demo assets while
preserving the full-training preflight bundle and required video evidence.
Compute creation is not started yet because the Nebius CLI OAuth token expired
during disk creation and browser reauthentication is required. The prepared launch record is
`evidence/nebius_full_training/clean_launch_prepared.json`.
The clean launch command now performs a Nebius CLI auth preflight before any
disk creation, instance creation, or runtime secret read. The latest resume
attempt exited quickly with `state=awaiting_nebius_cli_auth`, no disk ID, no
instance ID, and redacted auth evidence in
`evidence/nebius_full_training/clean_launch_status.json`.

The strict objective audit is now
`eliza-robot-audit-alberta-objective`. It writes
`evidence/alberta_objective_completion_audit.json` and `.md`; the latest audit
passes `alberta_framework_integrated` and `clean_relaunch_path_ready`, but fails
six production-dependent requirements because the active Nebius run has not
uploaded the trained checkpoint, comparison, continual benchmark, SOTA/Brax, or
checkpoint-bound video artifacts.

## Requirement Status

| requirement | status | evidence | remaining gate |
|---|---|---|---|
| Unified robot interface across profiles | smoke-proven | `evidence/agent_videos/manifest.json`, `evidence/video_review/video_review.json`, `validate_multi_robot_training_readiness.py`; now includes ASIMOV-1, Hiwonder AiNex, Unitree G1, Unitree H1, and Unitree R1 | production checkpoint videos after H200 training |
| Adaptation to robot-specific inputs and degrees of freedom | smoke-proven | Alberta and PPO manifests include profile `obs_dim`, `action_dim`, `output_dim`; Alberta validation checks profile/output mismatch | production Alberta checkpoint validation for target profile |
| Alberta fully integrated as a trainable backend | smoke-proven | `eliza_robot/rl/alberta`, `eliza-robot-train-alberta`, `evidence/backend_compare_smoke/alberta/manifest.json` | production checkpoint from `10_nebius_train_alberta` |
| Traditional model path for comparison | smoke-proven | `evidence/backend_compare_smoke/ppo/manifest.json`, `comparison.json`, `comparison.md` | production-budget `eliza-robot-compare-backends` artifact |
| Side-by-side Alberta vs PPO comparison | smoke-proven | `evidence/backend_compare_smoke/comparison.json`, `validation_report.json` with `winner_by_mean_reward=ppo`, consistent expected winner, and Alberta-vs-PPO mean-reward delta `-0.0002` | production comparison with full step budget and eval episodes |
| SOTA-style high-throughput baseline path | prepared | `evidence/full_training_preflight`, `evidence/nebius_convergence`, Brax/MJX baseline script in generated preflight | `40_nebius_brax_baseline` must finish on H200 |
| Continual online learning obstacle course | smoke-proven | `evidence/alberta_obstacle_course_smoke/continual_benchmark.json`, `.md`, `.png`, validator report | production `obstacle_course` benchmark at 16000 steps/task and 3 seeds |
| No catastrophic forgetting metric | regression-covered and smoke-proven | `tests/rl/alberta/test_metrics.py`, `forgetting=0.0` in obstacle-course smoke; validator now requires Alberta forgetting <= PPO when delta gates are enabled | production continual benchmark validation |
| Alberta-vs-PPO continual delta gates | smoke-proven | `evidence/alberta_obstacle_course_smoke/validation_report.json` reports `alberta_acc_gte_ppo=true`, `alberta_forgetting_lte_ppo=true`, ACC delta `1.5961`, forgetting delta `0.0` | production `joint_reach` and `obstacle_course` benchmarks must pass the same gates |
| Output videos for individual and combined actions | local-profile proven; remote run incomplete | 25 local reviewed MP4s exist under `evidence/agent_videos`, but the corrected Nebius prefix mirror currently contains 20 reviewed MP4s across `asimov-1`, `hiwonder-ainex`, `unitree-g1`, and `unitree-h1`; Unitree R1 videos/contact sheets are missing from this active upload. Current production-policy video gate sees the ASIMOV clips but correctly reports missing checkpoint binding | production checkpoint videos from `50_post_train_validation` with manifest/profile `policy_checkpoint` set; future launches include Unitree R1 in preflight |
| Automated video correctness review | proven locally; remote run incomplete | `eliza-robot-review-video-evidence`, `video_review.json`, `tests/rl/test_video_evidence_review.py`; each reviewed video now requires nonblank frames, frame delta, calibrated action progress, and a contact sheet. Current corrected partial closeout reports 20/20 OK uploaded reviewed videos, min visual progress `0.0002016`, mean visual progress `0.0038949`, mean frame delta `0.9932`. | rerun on production checkpoint videos and require all default profiles, including Unitree R1 |
| Detailed side-by-side final report | prepared | `training_comparison_report.json` / `.md` now include Alberta-vs-PPO reward delta, Alberta/PPO/untrained/Brax method matrix, deltas vs untrained, obstacle-course generalization deltas, forgetting deltas, SOTA baseline row, and completion gates | production metrics remain missing until the H200 run uploads the required artifacts |
| Text conditioning path | smoke-proven | backend comparison uses same task text, PCA text dimension, and eval prompts; training-input validator reports no launch-task collisions | production eval over full launch task set |
| Training data / dataset readiness | audited with warnings and closeout-gated | `evidence/full_training_preflight/training_inputs_report.json`; production validator now requires the report to be present, `ok=true`, include requested launch tasks, have no blockers, and include curriculum hash | offline imitation datasets absent; acceptable for RL-from-sim, not for imitation training |
| Nebius full training readiness | prepared and launched | `evidence/full_training_preflight/preflight_report.json` regenerated at 2026-05-23T10:13:05Z with `launch_template_hygiene=true`, `nebius_instance_launch_template.json`, `run_status.json` | active run must finish and upload artifacts, or a clean relaunch must use the safe template |
| End-to-end completion claim | blocked | smoke and preflight evidence exist | blocked on active production run completion |

## Critical Issues Found And Fixed

- Alberta-vs-PPO comparison was not passing `episode_steps` and
  `eval_episodes` to the real Alberta trainer. The CLI now passes those fields,
  and tests cover the signature.
- The continual-learning forgetting metric could report a negative value when
  later training improved a task. It is now clamped to non-negative forgetting,
  with a regression test.
- Video recording could silently depend on missing FFmpeg support or end early
  when a task terminated. `imageio[ffmpeg]` is now declared, recording fails
  loudly without it, and active writers continue through the requested frame
  budget.
- Backend comparison artifacts lacked a dedicated validator. The validator now
  checks JSON, Markdown, baseline eval, Alberta validation, Alberta eval, PPO
  eval, task list, profile, step budget, shared eval configuration
  (`seed`, `pca_dim`, `episode_steps`, `eval_episodes`, `max_steps`,
  `domain_rand`), Alberta-vs-PPO mean/per-task deltas, Alberta/PPO per-task
  deltas vs the untrained baseline, and consistency of `winner_by_mean_reward`.
  The per-task Alberta-vs-PPO deltas are now recomputed from the reported
  Alberta and PPO task rewards instead of only checking that per-task delta
  fields exist.
- The final comparison report was too easy to read as a prose summary. It now
  emits machine-checkable Alberta/PPO/untrained/Brax method rows, reward deltas,
  deltas vs the untrained baseline, obstacle-course ACC/forgetting deltas, and
  explicit completion-requirement gates. Its top-level `ok` field is now derived
  from all completion requirements, not just from finalization status. Those
  requirements now include the
  backend comparison validator's exact delta/winner checks:
  `backend_alberta_vs_ppo_delta_ok`,
  `backend_alberta_delta_vs_untrained_ok`,
  `backend_ppo_delta_vs_untrained_ok`, and `backend_winner_consistent`.
  They now also include `backend_eval_config_ok`, so a final comparison cannot
  omit the shared training/evaluation context.
- Video review previously proved nonblank moving clips, but did not expose a
  separate action-progress signal. It now records normalized frame delta,
  foreground centroid path, foreground mask delta, and a calibrated
  `visual_progress` metric; production video closeout requires that action
  progress check.
- Continual benchmark validation was structural. It now records Alberta-vs-PPO
  ACC and forgetting deltas and can require Alberta ACC >= PPO and Alberta
  forgetting <= PPO. It also validates `n_tasks`, expected result count, and
  raw task×phase matrix shape for every learner/seed. It now also requires
  distinct seed coverage per learner, so a multi-seed retention claim cannot be
  satisfied by duplicated or one-sided result rows. The production Nebius
  validator enables all of those gates for `joint_reach` and `obstacle_course`.
- The generated full-training launch bundle now also passes
  `--min-tasks 4`,
  `--require-alberta-acc-gte-ppo` and
  `--require-alberta-forgetting-lte-ppo` in
  `30_nebius_continual_benchmarks.sh`, so the Nebius stage itself fails early
  on continual-learning regressions instead of leaving those checks only to
  post-run closeout.
- The final report completion requirements now mirror those continual-learning
  gates directly: `joint_reach_alberta_acc_gte_ppo`,
  `joint_reach_alberta_forgetting_lte_ppo`,
  `obstacle_course_alberta_acc_gte_ppo`, and
  `obstacle_course_alberta_forgetting_lte_ppo`. They also include
  `joint_reach_task_matrix_ok` and `obstacle_course_task_matrix_ok`, which now
  require task count, result count, raw matrix shape, and learner seed coverage.
- Training-input and text-conditioning readiness was previously only a preflight
  artifact. It is now a production validation gate and inventory artifact:
  closeout requires `training_inputs_report.json` to be present, green, cover
  the requested launch tasks, have no blockers, and include the curriculum
  content hash. It now also requires `datasets.rl_from_sim_ready=true` and
  `datasets.offline_datasets_block_current_plan=false`, so a report that omits
  the training mode/dataset readiness contract cannot satisfy production
  closeout. The final generated report also surfaces launch tasks, warning
  kinds, RL-from-sim readiness, imitation readiness, offline dataset presence,
  offline-dataset blocking status, and the curriculum SHA256.
- The final report completion requirements now expose the individual
  training-input gates too: `training_inputs_present`,
  `training_inputs_launch_tasks_cover_requested`, `training_inputs_no_blockers`,
  `training_inputs_curriculum_hash`, `training_inputs_rl_from_sim_ready`, and
  `training_inputs_offline_datasets_not_blocking`.
- The final generated report now includes a validation-gate detail section that
  exposes the exact backend comparison, continual benchmark, Alberta checkpoint,
  ASIMOV-1 Alberta production, Brax full-run, Brax production checkpoint,
  training-input, multi-robot readiness, and video-review subchecks used by the
  production validator.
- The production Nebius validator now also runs the unified multi-robot
  readiness gate against `evidence/agent_videos`: every supported profile must
  compile in the shared text-conditioned env, Alberta must import, and
  per-action plus combined-action videos must be present. The final report
  exposes this via `multi_robot_readiness_ok`,
  `multi_robot_video_evidence_ok`, and
  `multi_robot_combined_videos_required`.
- Alberta production checkpoint gates are now first-class final-report
  completion requirements: `alberta_checkpoint_ok`,
  `alberta_checkpoint_regime_streaming`,
  `alberta_checkpoint_profile_matches`,
  `alberta_checkpoint_required_tasks`, `alberta_checkpoint_domain_rand`,
  `alberta_checkpoint_total_steps`, `alberta_checkpoint_inference`,
  `asimov1_alberta_production_ok`, `asimov1_alberta_regime_streaming`,
  `asimov1_alberta_required_tasks`, `asimov1_alberta_asset_provenance`, and
  `asimov1_alberta_inference_check`.
- The final generated report now includes the video action-progress summary
  used to support visual correctness: reviewed profiles, OK video count,
  minimum/mean `visual_progress`, and mean frame delta.
- The final generated report now includes a `multi_robot_video_manifest`
  summary and Markdown table with per-profile expected video count, present
  video count, missing files, undersized files, and combined-action clip
  presence.
- Multi-robot video readiness now survives the post-training ASIMOV video
  recorder rewriting `agent_videos/manifest.json`: the gate remains anchored to
  durable per-profile MP4 presence and size, while still reporting whether each
  profile had a manifest entry.
- Production-policy video evidence is now a separate validation and final-report
  gate: `production_policy_videos_ok`,
  `production_policy_videos_checkpoint_bound`, and
  `production_policy_videos_expected_actions`. This prevents preflight clips
  from satisfying the trained-policy video requirement.
- The final report completion requirements now also include explicit video
  gates: `video_action_progress_ok`, `video_min_visual_progress_met`, and
  `video_all_reviewed_ok`, so a final completion claim cannot rely on video
  count alone.
- The SOTA-style Brax/MJX baseline row now has explicit final-report completion
  gates: `brax_full_training_run_ok`, `brax_production_checkpoint_ok`,
  `brax_regime_ppo`, `brax_profile_matches`, and `brax_total_steps_present`.
- Runtime watching now writes both the latest snapshot and an append-only
  `runtime_watch_history.jsonl`, and the history file is part of the required
  artifact inventory.
- The production validator now requires runner/stage status artifacts in
  addition to stage logs: `status/runner_status.json` must be complete, and
  every `status/<stage>.json` must show `state=complete`, `returncode=0`,
  `started_at`, `ended_at`, and `heartbeat_at`. The final comparison report and
  artifact inventory now expose this as `stage_status_ok`,
  `runner_status_complete`, and `stage_status_all_complete`.
- Runtime watching now also treats terminal closeout states as terminal:
  `failed` recommends inspecting the failure log and `invalid` recommends
  inspecting failed validation gates instead of continuing to poll.
- The artifact inventory now requires human-reviewable benchmark outputs, not
  only benchmark JSON: `continual_benchmark.md` and `continual_benchmark.png`
  for both `joint_reach` and `obstacle_course`, plus the final
  `training_comparison_report.md`.
- The artifact inventory now also requires the ASIMOV production MP4s and their
  contact sheets for stand-up, walk-forward, turn-left, turn-right, and the
  combined action clip, so final closeout includes both the videos themselves
  and visual review assets alongside `video_review.json`.
- The cleanup plan previously emitted a generic blocker list whenever cleanup
  was not allowed. It now reports only the gates that actually failed and
  separates `complete` from `override_used`, so a forced early cleanup command
  set remains auditable as an override rather than a completed run.
- The validation Markdown now includes a failed-gate list and a production
  policy video section showing checkpoint binding, expected/present/missing
  videos, and the exact reason preflight clips do not satisfy production-policy
  evidence.
- Closeout no longer reports `state=complete` when the monitor is complete but
  inventory, finalization, or the generated training report is still failing.
  That case is now classified as `invalid` unless every closeout gate is green.
- Finalization now requires `artifact_inventory.ok=true`, not just monitor and
  validation success. A run cannot be finalized while videos, contact sheets,
  benchmark reports, comparison reports, checkpoints, or human-review summaries
  are missing from the archive.
- Artifact inventory now treats zero-byte required artifacts as missing. Empty
  checkpoint, video, contact-sheet, benchmark, report, or stage-log files can no
  longer satisfy archival completeness.
- The artifact inventory now also requires the non-ASIMOV all-robot MP4s for
  Hiwonder AiNex, Unitree G1, Unitree H1, and Unitree R1 across stand-up,
  walk-forward, turn-left, turn-right, and combined actions, so the
  unified-interface video evidence cannot collapse to a manifest-only claim.
- The artifact inventory now also requires the matching non-ASIMOV contact
  sheets for those same actions, so frame-review evidence is required for every
  supported robot profile, not only ASIMOV-1.
- The artifact inventory now includes category summaries. After switching
  closeout sync to a strict prefix mirror, current partial closeout has 52/80
  required artifacts present. Stage/status `0/6`, checkpoints `0/4`, backend
  comparison `0/2`, continual benchmarks `0/6`, and Unitree R1 uploaded
  videos/contact sheets remain pending from the active cloud run.
- The registered Unitree R1 profile is now part of the default all-robot
  readiness and recording set. It compiles in the shared text-conditioned env
  with 29 DOF, 12 leg actions, and 77 observation dims, and has reviewed
  per-action plus combined-action local video evidence. The already-launched
  Nebius payload predates that launch-bundle change, so the active remote prefix
  does not contain the Unitree R1 videos.
- Unitree R1 is now included in the learning-signal and unified-training CLI
  profile coverage alongside ASIMOV-1, Hiwonder AiNex, Unitree G1, and Unitree
  H1. The expanded 35-test slice passed, covering dry-run manifests, Alberta as
  default backend, profile/env output dimensions, fall/action reward signal, and
  domain randomization for the full five-profile set.
- Continual benchmark artifact validation now requires an exact learner/seed
  result grid: one Alberta and one PPO result for every configured seed, with no
  duplicate or extra rows. This prevents obstacle-course or joint-reach claims
  from passing on inflated row counts while still missing a real seed run.
- The final training comparison report now exposes that exact-grid requirement
  as `joint_reach_exact_learner_seed_grid` and
  `obstacle_course_exact_learner_seed_grid`. Both are currently `false` in the
  synced partial report because production benchmark artifacts have not uploaded.
- The all-robot video manifest can now preserve existing file-backed profile
  entries when a later recording pass adds or refreshes one profile. The
  readiness validator explicitly accepts those `manifest_source=existing_files`
  entries while still rejecting plain `exit_code=null` entries without that
  provenance.
- Multi-robot video validation now also requires the manifest command list and
  `record_combined` flag to match the expected action set. The final report
  exposes this as `multi_robot_video_commands_match` and
  `multi_robot_video_combined_recording_match`.
- The production-policy video gate now also checks that the referenced trained
  Alberta checkpoint artifacts exist. Current partial closeout sees the ASIMOV
  action MP4s, but correctly reports `checkpoint_exists=false`,
  `manifest_policy_checkpoint=false`, and `profile_policy_checkpoint=false`
  until `checkpoints/asimov_1_alberta_full` arrives from the production run.
- The production-policy video gate now also requires every expected trained
  policy MP4 to meet the minimum byte threshold through a `video_sizes`
  subcheck. The current uploaded ASIMOV preflight clips pass this size check,
  but still do not satisfy production-policy evidence because checkpoint
  binding is missing.
- Artifact inventory no longer requires `closeout_status.json`, which closeout
  writes after inventory generation. It now requires non-circular review
  summaries instead: `monitor_summary.md`, `validation_summary.md`, and
  `finalization_summary.md`.
- The curriculum loader used by policy adaptation no longer reads
  `model_fields` from a Pydantic model instance. It now uses the class-level
  field registry, removing the Pydantic 2.11 deprecation warning from the
  Alberta policy-adapter test path.
- The Alberta production checkpoint validator now rejects duplicate
  `active_tasks`. This prevents a manifest from satisfying required-task
  membership while silently repeating one task instead of training the intended
  unique curriculum phases.
- Continual benchmark validation now rejects NaN/Inf/boolean metric summaries,
  negative metric standard deviations, and non-finite or boolean raw
  task-by-phase matrix or baseline values. This prevents Alberta-vs-PPO and
  obstacle-course forgetting gates from passing on numerically invalid
  benchmark artifacts.
- Backend-comparison validation now rejects NaN/Inf/boolean mean rewards,
  per-task rewards, and delta values before recomputing Alberta-vs-PPO and
  untrained deltas. This prevents a traditional-vs-Alberta comparison from
  passing with invalid reward evidence.
- Backend-comparison generation now also fails before writing artifacts if the
  untrained, Alberta, or PPO evaluator returns missing, non-finite, or boolean
  overall/per-task rewards. Bad eval output cannot become a report artifact that
  only fails later in closeout.
- The generated local full-training launch bundle now includes Unitree R1 in
  `00_local_preflight.sh` via
  `--profiles hiwonder-ainex asimov-1 unitree-g1 unitree-h1 unitree-r1`, so
  future Nebius launches exercise the complete all-robot default set before
  upload.
- The full-training preflight bundle report now records `default_profiles`, and
  the bundle validator fails if `00_local_preflight.sh` omits any default robot
  profile. This makes the Unitree R1 launch requirement machine-checkable before
  the next Nebius run. `evidence/full_training_preflight` was regenerated at
  2026-05-23T10:13:05Z with `multi_robot_readiness=true`, Unitree R1 in the
  default profile list, `rl_from_sim_ready=true`,
  `offline_datasets_block_current_plan=false`, and
  `launch_template_hygiene=true`.
- The generated `00_local_preflight.sh` now runs
  `eliza-robot-validate-full-training-preflight evidence/full_training_preflight`
  after the training-input, multi-robot, Brax job, and ASIMOV readiness checks.
  Future Nebius hosts therefore validate the complete launch bundle before
  starting long GPU stages.
- The generated bundle now also includes `run_all_nebius_stages.sh`, backed by
  `eliza-robot-run-full-training-bundle`. That runner writes START/END-marked
  per-stage logs, per-stage status JSON, `runner_status.json`, success/failure
  markers, and optional periodic `logs/` + `status/` uploads through
  `NEBIUS_TRAINING_S3_URI`, using `NEBIUS_S3_ENDPOINT` for Nebius Object
  Storage. It records upload result summaries and then re-uploads `status/`
  after those summaries are written, so long stage-10 Alberta training can leave
  a heartbeat in object storage before the stage exits and expose upload
  failures instead of silently dropping them.
- The generated full-training preflight bundle now also writes
  `nebius_instance_launch_template.json` and validates it with the same launch
  hygiene gate used for active VM review. The template uses
  `run_all_nebius_stages.sh`, `NEBIUS_TRAINING_S3_URI`,
  `NEBIUS_S3_ENDPOINT`, status heartbeat evidence, and a hard shutdown cap, and
  deliberately leaves object-storage credentials to an external runtime secret
  file instead of embedding them in VM metadata.
- `eliza-robot-plan-nebius-training-relaunch` now creates
  `relaunch_plan.json` and `relaunch_plan.md` from the active closeout/runtime
  state plus the regenerated preflight bundle. It blocks accidental duplicate
  H200 execution while the current run is still running before the hard cap,
  but proves the clean relaunch bundle and launch-template hygiene are ready
  when an intentional relaunch is allowed.
- `eliza-robot-audit-alberta-objective` now maps the user-level objective to
  explicit machine-checkable requirements: Alberta integration, unified robot
  interface, PPO/Brax/SOTA baselines, Alberta-vs-PPO comparison, obstacle-course
  continual learning/no-forgetting, checkpoint-bound production videos, Nebius
  production closeout, and clean relaunch readiness. It intentionally treats
  local smoke evidence as insufficient for production completion.
- The stale H200 run exceeded its 12-hour hard cap without uploading stage-10
  logs or checkpoints and was stopped. The stopped run remains useful evidence
  of the old-wrapper launch failure, but it cannot satisfy production
  completion because it fails launch hygiene, stage-status, checkpoint,
  comparison, benchmark, and production-video gates.
- A clean relaunch package now exists in Object Storage under
  `robot-full-clean-1779556360`, with the concrete redacted instance request in
  `evidence/nebius_full_training/clean_instance_create_redacted.json`. The
  pending launch uses SSH-based runtime secret injection so object-storage
  credentials stay out of VM metadata.
- The clean relaunch payload was optimized to avoid uploading local virtualenvs,
  tool caches, stale synced Nebius payloads, checkpoints, and large unused demo
  assets. The current uploaded payload is about 57 MB and still includes
  `evidence/full_training_preflight` plus the required `evidence/agent_videos`
  manifest and MP4 evidence needed by remote preflight.
- The top-level `preflight_report.json` now surfaces
  `rl_from_sim_ready`, `imitation_training_ready`, and
  `offline_datasets_block_current_plan` directly under `training_inputs`, so
  reviewers do not need to inspect only the nested training-input report to
  confirm the planned RL-from-simulation mode.
- S3 sync for validation/monitor/closeout now uses `aws s3 sync --delete` with
  only runtime-watch local files excluded. This fixed a stale-evidence gap where
  local files left in `synced_run` could make the remote artifact inventory look
  more complete than the Nebius prefix actually was.
- The final generated training report now uses the same finite-number discipline
  for displayed means, deltas, video action-progress metrics, and Brax step
  gates. Boolean values are no longer formatted or subtracted as numeric
  evidence in the human-readable comparison report.
- ASIMOV-1 production checkpoint validation now rejects boolean reward metrics
  and boolean observation-delay step values instead of accepting them through
  Python integer coercion. Boolean metric `steps` values are ignored rather than
  counting toward the production step threshold.
- ASIMOV-1 full Brax/MJX run validation now binds the post-training production
  checkpoint validator to the exact `ppo.num_timesteps` budget from
  `training_job.json`. A final SOTA baseline report can no longer pass with a
  token `--min-steps` flag that is lower than the requested training budget.
- `eliza-robot-validate-nebius-instance-launch` now audits Nebius instance
  metadata without printing secrets. The current active instance fails that
  hygiene check because its older cloud-init wrapper embeds object-storage
  credential environment variables, bypasses the repo-owned stage runner,
  reconstructs upload paths instead of using `NEBIUS_TRAINING_S3_URI`, and has
  no heartbeat/status upload contract during long stages. The redacted report is
  `evidence/nebius_full_training/instance_launch_hygiene.json`. Future launches
  should use `run_all_nebius_stages.sh` / `eliza-robot-run-full-training-bundle`
  and inject upload authority outside persistent VM metadata where possible.
- The Nebius production validator, final report, and artifact inventory now all
  gate on that launch-hygiene report. The current closeout therefore lists
  `instance_launch_hygiene` as a failed gate even though the redacted report is
  present, because the active launch used the older no-heartbeat cloud-init
  wrapper.

## Known Non-Blockers For Current Plan

- Offline imitation datasets are not present. This does not block the current
  RL-from-simulation and continual-learning plan, but it would block a claim
  that imitation or demonstration training is ready. The training-input report
  now records this explicitly as `rl_from_sim_ready=true`,
  `imitation_training_ready=false`, and
  `offline_datasets_block_current_plan=false`.
- Higher-tier curriculum tasks that require target scenes, grippers, prone
  initialization, or unsupported reward/success keys remain outside the current
  launch task set.
- The active Nebius payload was inspected from S3. It was launched before the
  local preflight generator gained the Unitree R1 default profile, the
  backend-comparison validator stage, and post-train video review. The
  production comparison artifact and production videos can still be validated
  after upload with
  `eliza-robot-validate-nebius-full-training`, which now syncs the run prefix
  and applies the backend comparison, benchmark, checkpoint, Brax/MJX, stage-log,
  success-marker, and video frame-review gates in one report.

## Required Production Artifacts Before Closing

- `status/success.txt` for `robot-full-1779504720`.
- Production Alberta checkpoint and validator report.
- Production Alberta-vs-PPO `comparison.json`, `comparison.md`, and backend
  comparison validator report with Alberta-vs-PPO deltas and a winner consistent
  with mean reward.
- Production continual benchmark artifacts for `joint_reach` and
  `obstacle_course`, including JSON, Markdown, plot, and validator reports with
  Alberta ACC >= PPO and Alberta forgetting <= PPO delta gates enabled.
- Production Brax/MJX / MuJoCo Playground baseline artifacts.
- Production checkpoint action videos as MP4s, `video_review.json`, ASIMOV
  contact sheets for each action plus combined action, and
  `production_policy_videos` validation with the video manifest and ASIMOV-1
  profile entry bound to `checkpoints/asimov_1_alberta_full`.
- Full-training `training_inputs_report.json`, with `ok=true`, no blockers,
  requested launch tasks covered, and curriculum hash present.
- Post-run bundle validation from
  `eliza-robot-validate-nebius-full-training --run-id robot-full-1779504720 --bucket robot-rl-results-1779358330`,
  producing `evidence/nebius_full_training/synced_run/validation_report.json`
  and `validation_summary.md`.
- One-shot monitor state from
  `eliza-robot-monitor-nebius-full-training --run-id robot-full-1779504720 --bucket robot-rl-results-1779358330`,
  producing `evidence/nebius_full_training/synced_run/monitor_status.json`
  and `monitor_summary.md` with `state=complete`.
- Guarded finalization from
  `eliza-robot-finalize-nebius-full-training evidence/nebius_full_training/synced_run`,
  producing `finalization_report.json` and `finalization_summary.md` with
  `ok=true`.
- Artifact-driven final comparison report from
  `eliza-robot-generate-nebius-training-report evidence/nebius_full_training/synced_run`,
  producing `training_comparison_report.json` and
  `training_comparison_report.md` with production Alberta/PPO, continual, SOTA
  baseline, method-matrix, obstacle-generalization, forgetting-delta, and video
  evidence metrics filled in, plus the validation-gate detail section showing
  backend delta/winner checks, continual benchmark delta gates, Alberta
  checkpoint gates, ASIMOV-1 production checkpoint gates, training-input checks,
  and video action-progress thresholds.
- One-command closeout from
  `eliza-robot-closeout-nebius-full-training --run-id robot-full-1779504720 --bucket robot-rl-results-1779358330`,
  producing `closeout_status.json` and `closeout_summary.md` with `ok=true`.
- Artifact inventory from the closeout command, producing
  `artifact_inventory.json` and `artifact_inventory.md` with all required
  production artifacts present, including monitor, validation, finalization, and
  training-comparison human-review summaries plus the all-robot video manifest.
- Cleanup plan from
  `eliza-robot-plan-nebius-training-cleanup evidence/nebius_full_training/synced_run --instance-id computeinstance-e00x4sqmx07qwehxrc --disk-id computedisk-e00te9qnayns1bsz15`,
  producing `cleanup_plan.json` and `cleanup_plan.md` with cleanup allowed only
  after closeout, finalization, artifact inventory, `validation_report.ok`, and
  `training_comparison_report.ok` are all true.
- Runtime watch from
  `eliza-robot-watch-nebius-training-runtime evidence/nebius_full_training/synced_run --instance-created-at 2026-05-23T02:58:03.322832Z`,
  producing `runtime_watch.json`, `runtime_watch.md`, and
  `runtime_watch_history.jsonl` with no stale or hard-cap-exceeded condition.
- Final report update that replaces all production-pending rows above with
  completed evidence paths.
