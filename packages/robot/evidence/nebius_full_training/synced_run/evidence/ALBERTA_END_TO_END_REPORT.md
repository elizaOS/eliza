# Alberta End-to-End Evidence Report

Result: `ok`
Generated: `2026-05-24T07:20:29.899784Z`
Scope: `production-nebius-post-training`
Production complete: `False`
Production blocker: `none`

## Objective Requirements

| requirement | status | evidence | gaps |
|---|---|---|---|
| `alberta_framework_integrated` | `proved` | objective_audit_passed=`True`, backend_validation_ok=`True`, integration_surfaces_ok=`True`, integration_checks=`{'dependency': True, 'source_override': True, 'modules': True, 'public_exports': True, 'console_scripts': True, 'files': True}` | none |
| `unified_robot_interface_all_profiles` | `proved` | objective_audit_passed=`True`, video_profiles=`['asimov-1']`, manifest_review_consistent=`True` | none |
| `traditional_and_sota_baselines` | `proved` | stable_baselines3_ppo_artifact=`True`, stable_baselines3_sac_artifact=`True`, stable_baselines3_sac_ok=`True`, brax_mjx_ppo_preflight_ok=`True`, brax_mjx_ppo_manifest_present=`True`, brax_mjx_ppo_contract_artifact_ok=`True`, brax_mjx_ppo_contract_only=`True`, brax_mjx_ppo_production_training=`False` | none |
| `training_inputs_text_conditioning_and_datasets` | `proved` | training_inputs_ok=`True`, launch_tasks=`7`, supported_launch_tasks=`7`, ready_profiles=`5`, rl_from_sim_ready=`True`, offline_datasets_present=`False`, offline_datasets_block_current_plan=`False`, text_variant_collision_count=`0`, curriculum_content_sha256=`cd524c5bf5fce957d4a1eb591db02290952e09a5a54953e6c7c3a53599d5debe` | none |
| `alberta_checkpoint_inference_contract` | `proved` | checkpoint_validation_count=`7`, checkpoint_validation_ok_count=`7`, profiles=`['asimov-1', 'hiwonder-ainex', 'unitree-g1', 'unitree-h1', 'unitree-r1']`, ready_profiles=`['asimov-1', 'hiwonder-ainex', 'unitree-g1', 'unitree-h1', 'unitree-r1']`, all_ready_profiles_have_checkpoint_inference=`True`, all_inference_ok=`True`, any_inference_ok=`True` | none |
| `local_test_validation_suite` | `proved` | tests=`123`, passed=`123`, failures=`0`, errors=`0`, skipped=`0`, junit_xml=`evidence/local_validation/alberta_robot_validation.xml` | none |
| `alberta_vs_baselines_side_by_side` | `proved` | backend_comparison_count=`4`, green_backend_comparison_count=`3`, green_backend_profiles=`['asimov-1', 'asimov-1', 'hiwonder-ainex']`, sac_learners=`['alberta', 'ppo', 'sac']` | none |
| `continual_unseen_obstacle_learning_no_forgetting` | `proved` | obstacle_validation_ok=`True`, alberta_acc_minus_ppo=`-2.03744`, alberta_forgetting_minus_ppo=`-2.79921`, obstacle_demo_ok=`True`, sac_demo_ok=`True`, alberta_new_task_gain=`1.70479`, sac_alberta_new_task_gain=`0.373737` | none |
| `robot_action_videos_self_reviewed` | `partial` | video_review_ok=`True`, video_count=`5`, profiles=`['asimov-1']`, all_videos_reviewed_good=`True`, manifest_review_consistent=`True`, failed_review_count=`0`, checkpoint_bound_local_policy_videos_ok=`False`, checkpoint_bound_video_count=`15`, checkpoint_bound_profiles=`['asimov-1', 'hiwonder-ainex', 'unitree-g1', 'unitree-h1', 'unitree-r1']` | video review, manifest consistency, or checkpoint-bound local policy videos are incomplete |
| `checkpoint_bound_local_policy_videos_reviewed` | `missing` | checkpoint_video_validation_ok=`True`, checkpoint_bound_local_policy_videos_ok=`False`, checkpoint_bound_video_count=`15`, checkpoint_bound_expected_video_count=`15`, checkpoint_bound_profiles=`['asimov-1', 'hiwonder-ainex', 'unitree-g1', 'unitree-h1', 'unitree-r1']`, checkpoint_bound_actions=`['combined_actions', 'stand_up', 'walk_forward']`, policy_source_ok_count=`15`, task_signal_ok_count=`15`, all_expected_reviewed=`True`, telemetry_failed_count=`0` | checkpoint-bound local policy videos are missing or failed validation |
| `detailed_report_generated` | `proved` | evidence_consistent=`True`, has_backend_matrix=`True`, has_obstacle_metrics=`True`, has_video_metrics=`True`, has_sac_comparison=`True` | none |
| `nebius_production_training_complete` | `missing` | objective_audit_failed=`True`, production_blocker=`missing` | Nebius production training is still gated by CLI auth or missing production artifacts |

## Alberta Integration Surfaces

| surface | value |
|---|---:|
| validation ok | `True` |
| dependency wired | `True` |
| vendored source override | `True` |
| modules import | `True` |
| public exports | `True` |
| console scripts | `True` |
| package files | `True` |


## Alberta vs PPO

| field | value |
|---|---:|
| profile | `asimov-1` |
| tasks | `stand_up, walk_forward, walk_backward, sidestep_left, sidestep_right, turn_left, turn_right` |
| steps | `30000` |
| winner | `ppo` |
| untrained mean reward | `251.505` |
| Alberta mean reward | `165.821` |
| PPO mean reward | `194.844` |
| Alberta minus untrained | `-85.684` |
| PPO minus untrained | `-56.6615` |
| Alberta minus PPO | `-29.0226` |
| Alberta >= PPO | `False` |
| min mean steps survived | `56` |
| Alberta min mean steps survived | `56` |
| PPO min mean steps survived | `65` |

## Robot Backend Comparison Matrix

| field | value |
|---|---:|
| comparisons | `4` |
| green comparisons | `3` |
| profiles | `asimov-1, hiwonder-ainex` |
| any Alberta >= PPO | `False` |
| all green Alberta >= PPO | `False` |

| comparison | profile | ok | winner | untrained | Alberta | PPO | Alberta - untrained | PPO - untrained | Alberta - PPO | survival min |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| `asimov-1-profile-4k` | `asimov-1` | `True` | `ppo` | `248.366` | `159.97` | `247.431` | `-88.3965` | `-0.935111` | `-87.4614` | `49` |
| `hiwonder-ainex-4k` | `hiwonder-ainex` | `False` | `alberta` | `-6.83711` | `-6.83724` | `-6.83742` | `-0.000130629` | `-0.000308977` | `0.000178348` | `1` |
| `hiwonder-ainex-4k-rootfix` | `hiwonder-ainex` | `True` | `ppo` | `409.255` | `409.193` | `409.255` | `-0.062007` | `-0.000465055` | `-0.0615419` | `120` |
| `asimov-1` | `asimov-1` | `True` | `ppo` | `251.505` | `165.821` | `194.844` | `-85.684` | `-56.6615` | `-29.0226` | `56` |

## SOTA Baseline Evidence

| baseline | role | evidence |
|---|---|---|
| `stable_baselines3_ppo` | matched robot-policy baseline | local artifact present: `True` |
| `brax_mjx_ppo` | SOTA-style accelerator PPO baseline | preflight ok: `True`, script present: `True`, manifest present: `True`, contract artifact ok: `True`, contract only: `True`, production training: `False`, contract profile: `asimov-1`, contract steps: `8` |
| `stable_baselines3_sac` | optional off-policy maximum-entropy baseline | artifact present: `True`, ok: `True`, learners: `alberta, ppo, sac` |

## Training Inputs And Datasets

| field | value |
|---|---:|
| training inputs ok | `True` |
| launch tasks | `7` |
| supported launch tasks | `7` |
| ready profiles | `5` |
| curriculum version | `2` |
| curriculum task count | `22` |
| curriculum SHA256 | `cd524c5bf5fce957d4a1eb591db02290952e09a5a54953e6c7c3a53599d5debe` |
| text variant collisions | `0` |
| RL-from-sim ready | `True` |
| offline datasets present | `False` |
| imitation training ready | `False` |
| offline datasets block current plan | `False` |
| trajectory DB tooling present | `True` |
| blocker count | `0` |
| warning kinds | `unsupported_future_curriculum_tasks, no_offline_policy_datasets` |

## Alberta Checkpoint Inference

| field | value |
|---|---:|
| validation reports | `7` |
| passing reports | `7` |
| profiles | `asimov-1, hiwonder-ainex, unitree-g1, unitree-h1, unitree-r1` |
| all inference ok | `True` |
| any inference ok | `True` |

| checkpoint | profile | ok | steps | inference | failed checks |
|---|---|---:|---:|---:|---|
| `asimov-1` | `asimov-1` | `True` | `6` | `True` | `none` |
| `hiwonder-ainex` | `hiwonder-ainex` | `True` | `6` | `True` | `none` |
| `unitree-g1` | `unitree-g1` | `True` | `6` | `True` | `none` |
| `unitree-h1` | `unitree-h1` | `True` | `6` | `True` | `none` |
| `unitree-r1` | `unitree-r1` | `True` | `6` | `True` | `none` |
| `asimov-1-profile-4k` | `asimov-1` | `True` | `4000` | `True` | `none` |
| `hiwonder-ainex-4k-rootfix` | `hiwonder-ainex` | `True` | `4000` | `True` | `none` |

## Local Validation

| field | value |
|---|---:|
| validation ok | `True` |
| tests | `123` |
| passed | `123` |
| failures | `0` |
| errors | `0` |
| skipped | `0` |
| time seconds | `63.84` |
| JUnit XML | `evidence/local_validation/alberta_robot_validation.xml` |
| known warnings | `JAXopt deprecation warning from Brax/MJX import path, JAX os.fork warning from obstacle demo renderer subprocess tests` |

| coverage scope |
|---|
| Alberta continual-learning agent, metrics, benchmark harness, checkpoint validator, policy adapter, vendoring validator |
| Alberta integration surfaces: package modules, public exports, pyproject dependency, editable vendored source, CLI entrypoints, and implementation files |
| Robot backend Alberta/PPO/untrained comparison artifacts and validation |
| Obstacle-course demo rendering with Alberta/PPO/SAC visual evidence and artifact file proof |
| Brax/MJX PPO artifact writer/config/manifest contract proof |
| Alberta objective audit with checkpoint-bound video and Brax/MJX contract evidence |
| Alberta end-to-end report generation, objective proof table, comparison interpretation, checkpoint-bound video provenance proof, review contact-sheet summaries, contact-sheet file-presence proof, task-signal telemetry proof, and explicit Alberta-vs-SAC deltas |
| Multi-robot training readiness and checkpoint-bound video manifest preservation |
| Training-input, text-conditioning, curriculum, profile, and dataset validation |
| Nebius launch/full-training validators, artifact inventory, and training report gates |

### Optional SAC Continual Comparison

| field | value |
|---|---:|
| path | `/root/robot/evidence/alberta_obstacle_course_sac_smoke` |
| env | `obstacle_course` |
| tasks | `2` |
| steps per task | `40` |
| eval episodes | `1` |
| Alberta ACC | `0.461244` |
| PPO ACC | `0.407144` |
| SAC ACC | `0.0457485` |
| Alberta forgetting | `0` |
| PPO forgetting | `0.0692023` |
| SAC forgetting | `0` |
| Alberta ACC delta vs PPO | `0.0540998` |
| Alberta forgetting delta vs PPO | `-0.0692023` |
| Alberta ACC delta vs SAC | `0.415495` |
| Alberta forgetting delta vs SAC | `0` |
| Alberta new-task gain | `0.373737` |
| PPO new-task gain | `0.345648` |
| SAC new-task gain | `0` |
| Alberta new-task gain delta vs SAC | `0.373737` |
| Alberta advantage vs SAC | `True` |
| demo video ok | `True` |
| demo learners | `alberta, ppo, sac` |
| demo video | `evidence/alberta_obstacle_course_sac_smoke/obstacle_course_demo.mp4` |
| demo frames | `24` |
| visual review | `good` |
| demo video file exists | `True` |
| demo video bytes match | `True` |
| demo review contact sheet exists | `True` |

## Continual Obstacle Course

| field | value |
|---|---:|
| env | `obstacle_course` |
| tasks | `4` |
| steps per task | `16000` |
| eval episodes | `10` |
| seeds | `3` |
| Alberta ACC | `2.11056` |
| PPO ACC | `4.148` |
| Alberta BWT | `0` |
| PPO BWT | `-2.77212` |
| Alberta forgetting | `0` |
| PPO forgetting | `2.79921` |
| Alberta FWT | `0` |
| PPO FWT | `-0.0350768` |
| ACC delta | `-2.03744` |
| forgetting delta | `-2.79921` |
| Alberta new-task gain | `1.70479` |
| PPO new-task gain | `5.81419` |
| Alberta task-0 retention delta | `0` |
| PPO task-0 retention delta | `-4.99525` |
| Alberta ACC >= PPO | `False` |
| Alberta forgetting <= PPO | `True` |
| demo video ok | `True` |
| demo video | `/root/robot/evidence/alberta_obstacle_course/obstacle_course_demo.mp4` |
| demo frames | `72` |
| visual review | `missing` |
| demo video file exists | `True` |
| demo video bytes match | `True` |
| demo review contact sheet exists | `False` |

## Video Review

| field | value |
|---|---:|
| videos | `5` |
| profiles | `asimov-1` |
| actions | `combined_actions, stand_up, turn_left, turn_right, walk_forward` |
| manifest videos | `5` |
| expected videos | `5` |
| manifest/review consistent | `True` |
| all manifest profiles ok | `True` |
| all videos reviewed good | `True` |
| manual annotations | `0` |
| failed frame reviews | `0` |
| min frame count | `40` |
| min visual progress | `0.00589874` |
| mean visual progress | `0.0110636` |
| contact sheets | `5` |
| existing contact sheets | `5` |
| missing contact sheets | `0` |
| representative reviewed clips | `5` |

### Representative Video Review Artifacts

| profile | action | verdict | frames | visual progress | contact sheet | notes |
|---|---|---|---:|---:|---|---|
| `asimov-1` | `combined_actions` | `good` | `160` | `0.00589874` | `/root/robot/evidence/video_review/asimov-1_asimov-1_combined_actions_contact.jpg` exists=`True` | Sampled frames show a nonblank robot sequence across the combined action script with measurable frame-to-frame or centroid progress. |
| `asimov-1` | `stand_up` | `good` | `40` | `0.0134465` | `/root/robot/evidence/video_review/asimov-1_asimov-1_stand_up_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `stand up` with measurable frame-to-frame or centroid progress. |
| `asimov-1` | `turn_left` | `good` | `40` | `0.0119873` | `/root/robot/evidence/video_review/asimov-1_asimov-1_turn_left_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `turn left` with measurable frame-to-frame or centroid progress. |
| `asimov-1` | `turn_right` | `good` | `40` | `0.0120001` | `/root/robot/evidence/video_review/asimov-1_asimov-1_turn_right_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `turn right` with measurable frame-to-frame or centroid progress. |
| `asimov-1` | `walk_forward` | `good` | `40` | `0.0119851` | `/root/robot/evidence/video_review/asimov-1_asimov-1_walk_forward_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `walk forward` with measurable frame-to-frame or centroid progress. |

## Checkpoint-Bound Alberta Videos

| field | value |
|---|---:|
| review ok | `False` |
| profiles | `asimov-1, hiwonder-ainex, unitree-g1, unitree-h1, unitree-r1` |
| videos | `15` / `15` |
| actions | `combined_actions, stand_up, walk_forward` |
| all videos reviewed good | `True` |
| telemetry ok | `15` / `15` |
| provenance validation ok | `True` |
| telemetry policy source ok | `15` / `15` |
| telemetry task signal ok | `15` / `15` |
| checkpoint mismatches | `5` |
| min frame count | `30` |
| min visual progress | `0.00274613` |
| contact sheets | `15` |
| existing contact sheets | `15` |
| missing contact sheets | `0` |
| representative reviewed clips | `10` |

### Representative Checkpoint-Bound Review Artifacts

| profile | action | verdict | frames | visual progress | contact sheet | notes |
|---|---|---|---:|---:|---|---|
| `asimov-1` | `combined_actions` | `good` | `60` | `0.00448694` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/asimov-1_asimov-1_combined_actions_contact.jpg` exists=`True` | Sampled frames show a nonblank robot sequence across the combined action script with measurable frame-to-frame or centroid progress. |
| `asimov-1` | `stand_up` | `good` | `30` | `0.0027464` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/asimov-1_asimov-1_stand_up_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `stand up` with measurable frame-to-frame or centroid progress. |
| `asimov-1` | `walk_forward` | `good` | `30` | `0.00274613` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/asimov-1_asimov-1_walk_forward_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `walk forward` with measurable frame-to-frame or centroid progress. |
| `hiwonder-ainex` | `combined_actions` | `good` | `60` | `0.00329628` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/hiwonder-ainex_hiwonder-ainex_combined_actions_contact.jpg` exists=`True` | Sampled frames show a nonblank robot sequence across the combined action script with measurable frame-to-frame or centroid progress. |
| `hiwonder-ainex` | `stand_up` | `good` | `30` | `0.0033294` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/hiwonder-ainex_hiwonder-ainex_stand_up_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `stand up` with measurable frame-to-frame or centroid progress. |
| `hiwonder-ainex` | `walk_forward` | `good` | `30` | `0.00328795` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/hiwonder-ainex_hiwonder-ainex_walk_forward_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `walk forward` with measurable frame-to-frame or centroid progress. |
| `unitree-g1` | `combined_actions` | `good` | `60` | `0.00458884` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/unitree-g1_unitree-g1_combined_actions_contact.jpg` exists=`True` | Sampled frames show a nonblank robot sequence across the combined action script with measurable frame-to-frame or centroid progress. |
| `unitree-g1` | `stand_up` | `good` | `30` | `0.00306512` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/unitree-g1_unitree-g1_stand_up_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `stand up` with measurable frame-to-frame or centroid progress. |
| `unitree-g1` | `walk_forward` | `good` | `30` | `0.00307299` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/unitree-g1_unitree-g1_walk_forward_contact.jpg` exists=`True` | Sampled frames show nonblank robot motion for `walk forward` with measurable frame-to-frame or centroid progress. |
| `unitree-h1` | `combined_actions` | `good` | `60` | `0.0111318` | `/home/shaw/milady/eliza/packages/robot/evidence/alberta_checkpoint_video_review/unitree-h1_unitree-h1_combined_actions_contact.jpg` exists=`True` | Sampled frames show a nonblank robot sequence across the combined action script with measurable frame-to-frame or centroid progress. |

## Claim Support

| claim | supported |
|---|---:|
| evidence internally consistent | `True` |
| Alberta robot backend advantage | `False` |
| Alberta obstacle-course advantage | `False` |
| obstacle demo video | `True` |
| production objective complete | `False` |

## Comparison Interpretation

| surface | result |
|---|---|
| robot backend mean reward | Local robot-backend mean-reward evidence does not show an Alberta advantage over PPO. |
| obstacle continual learning | Continual obstacle-course evidence does not currently support an Alberta advantage. |
| methods compared | `stable-baselines3 PPO, stable-baselines3 SAC, Brax/MJX PPO preflight, Brax/MJX PPO contract artifact` |
| Alberta >= PPO robot-backend count | `0` / `3` |
| obstacle advantage supported | `False` |

This report is generated from the configured evidence artifacts. It does not claim production completion unless the strict objective audit is green.
