from __future__ import annotations

import json
from pathlib import Path

from scripts.generate_nebius_training_report import (
    generate_nebius_training_report,
    main,
    write_markdown,
)


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def _benchmark(summary_root: Path) -> None:
    _write_json(
        summary_root / "continual_benchmark.json",
        {
            "summary": {
                "alberta": {
                    "acc": {"mean": 4.0},
                    "forgetting": {"mean": 0.0},
                },
                "ppo": {
                    "acc": {"mean": 2.0},
                    "forgetting": {"mean": 0.5},
                },
            }
        },
    )


def test_generate_nebius_training_report_reads_complete_artifacts(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "monitor_status.json", {"run_id": "robot-full-test", "state": "complete"})
    _write_json(
        run / "validation_report.json",
        {
            "run_id": "robot-full-test",
            "ok": True,
            "reports": {
                "stage_status": {
                    "ok": True,
                    "checks": {
                        "runner_status": True,
                        "all_stage_statuses": True,
                    },
                    "runner": {
                        "state": "complete",
                        "ok": True,
                        "last_stage": "50_post_train_validation",
                    },
                    "stages": {
                        "00_local_preflight": True,
                        "10_nebius_train_alberta": True,
                        "20_nebius_compare_backends": True,
                        "30_nebius_continual_benchmarks": True,
                        "40_nebius_brax_baseline": True,
                        "50_post_train_validation": True,
                    },
                },
                "training_inputs": {
                    "ok": True,
                        "checks": {
                            "present": True,
                            "launch_tasks_cover_requested": True,
                            "no_blockers": True,
                            "curriculum_hash": True,
                            "rl_from_sim_ready": True,
                            "offline_datasets_not_blocking_current_plan": True,
                        },
                    "warning_kinds": ["no_offline_policy_datasets"],
                },
                "multi_robot_readiness": {
                    "ok": True,
                    "profiles": {
                        "asimov-1": {"ok": True},
                        "hiwonder-ainex": {"ok": True},
                    },
                    "video_evidence": {
                        "ok": True,
                        "commands_match": True,
                        "combined_recording_match": True,
                        "require_combined": True,
                        "manifest": "/tmp/agent_videos/manifest.json",
                        "manifest_ok_field": True,
                        "profiles": [
                            {
                                "profile": "asimov-1",
                                "ok": True,
                                "expected": [
                                    "asimov-1_stand_up.mp4",
                                    "asimov-1_combined_actions.mp4",
                                ],
                                "present": [
                                    {"name": "asimov-1_stand_up.mp4", "bytes": 4096},
                                    {
                                        "name": "asimov-1_combined_actions.mp4",
                                        "bytes": 8192,
                                    },
                                ],
                                "missing": [],
                                "too_small": [],
                            },
                            {
                                "profile": "hiwonder-ainex",
                                "ok": True,
                                "expected": [
                                    "hiwonder-ainex_stand_up.mp4",
                                    "hiwonder-ainex_combined_actions.mp4",
                                ],
                                "present": [
                                    {
                                        "name": "hiwonder-ainex_stand_up.mp4",
                                        "bytes": 4096,
                                    },
                                    {
                                        "name": "hiwonder-ainex_combined_actions.mp4",
                                        "bytes": 8192,
                                    },
                                ],
                                "missing": [],
                                "too_small": [],
                            },
                        ],
                    },
                },
                "backend_comparison": {
                    "ok": True,
                    "checks": {
                        "alberta_vs_ppo_delta": True,
                        "alberta_delta_vs_untrained": True,
                        "ppo_delta_vs_untrained": True,
                        "eval_config": True,
                        "winner_consistent": True,
                        "eval_rollout_depth": True,
                    },
                    "deltas": {
                        "alberta_minus_ppo_mean_reward": 1.0,
                        "expected_winner_by_mean_reward": "alberta",
                    },
                },
                "joint_reach_benchmark": {
                    "ok": True,
                    "checks": {
                        "tasks": True,
                        "result_count": True,
                        "learner_seed_pairs": True,
                        "learner_seed_coverage": True,
                        "matrix_shapes": True,
                        "alberta_acc_gte_ppo": True,
                        "alberta_forgetting_lte_ppo": True,
                    },
                    "deltas": {
                        "alberta_acc_minus_ppo": 2.0,
                        "alberta_forgetting_minus_ppo": -0.5,
                    },
                    "required_deltas": {
                        "require_alberta_acc_gte_ppo": True,
                        "require_alberta_forgetting_lte_ppo": True,
                    },
                },
                "obstacle_course_benchmark": {
                    "ok": True,
                    "checks": {
                        "tasks": True,
                        "result_count": True,
                        "learner_seed_pairs": True,
                        "learner_seed_coverage": True,
                        "matrix_shapes": True,
                        "alberta_acc_gte_ppo": True,
                        "alberta_forgetting_lte_ppo": True,
                    },
                    "deltas": {
                        "alberta_acc_minus_ppo": 2.0,
                        "alberta_forgetting_minus_ppo": -0.5,
                    },
                    "required_deltas": {
                        "require_alberta_acc_gte_ppo": True,
                        "require_alberta_forgetting_lte_ppo": True,
                    },
                },
                "alberta_checkpoint": {
                    "ok": True,
                    "profile_id": "asimov-1",
                    "total_steps": 150000000,
                    "checks": {
                        "regime": True,
                        "profile_id": True,
                        "required_tasks": True,
                        "domain_rand": True,
                        "total_steps": True,
                        "inference": True,
                    },
                },
                "asimov1_alberta_production": {
                    "ok": True,
                    "production_regime": "alberta_streaming",
                    "max_metric_steps": 150000000,
                    "checks": {
                        "required_tasks": True,
                        "manifest_mjcf_asset_provenance": True,
                        "manifest_asset_manifest_provenance": True,
                        "inference_check": True,
                    },
                },
                "brax_full_training_run": {
                    "ok": True,
                    "checks": {"training_completed": True},
                },
                "brax_production_checkpoint": {
                    "ok": True,
                    "checks": {"policy_artifact": True},
                },
                "video_review": {
                    "ok": True,
                    "checks": {"action_progress": True},
                    "thresholds": {"min_visual_progress": 0.0001},
                    "video_count": 4,
                },
                "production_policy_videos": {
                    "ok": True,
                    "profile_id": "asimov-1",
                        "checkpoint": "/tmp/checkpoints/asimov_1_alberta_full",
                        "checks": {
                            "checkpoint_exists": True,
                            "manifest_policy_checkpoint": True,
                            "profile_policy_checkpoint": True,
                        "expected_videos": True,
                        "video_sizes": True,
                        "expected_telemetry": True,
                        "telemetry_sizes": True,
                        "combined_video": True,
                    },
                },
                "instance_launch_hygiene": {
                    "ok": True,
                    "checks": {
                        "no_inline_object_storage_credentials": True,
                        "uses_repo_owned_stage_runner": True,
                        "uses_training_s3_uri": True,
                        "has_status_heartbeat_upload_contract": True,
                    },
                    "secret_fields_embedded": [],
                },
            },
        },
    )
    _write_json(run / "finalization_report.json", {"ok": True, "missing_gates": []})
    _write_json(
        run / "evidence" / "backend_compare" / "asimov-1" / "comparison.json",
        {
            "profile_id": "asimov-1",
            "tasks": ["stand_up"],
            "steps": 30000,
            "winner_by_mean_reward": "alberta",
            "baseline": {"mean_reward_overall": 1.0},
            "alberta": {"eval": {"mean_reward_overall": 3.0}},
            "ppo": {"eval": {"mean_reward_overall": 2.0}},
        },
    )
    _benchmark(run / "evidence" / "alberta_joint_reach")
    _benchmark(run / "evidence" / "alberta_obstacle_course")
    _write_json(
        run / "evidence" / "full_training_preflight" / "asimov_1_brax_mjx_baseline" / "manifest.json",
        {"regime": "brax_ppo", "total_steps": 150000000, "profile_id": "asimov-1"},
    )
    _write_json(
        run / "evidence" / "video_review_production" / "video_review.json",
        {
            "ok": True,
            "video_count": 4,
            "videos": [
                {
                    "profile": "asimov-1",
                    "ok": True,
                    "visual_progress": 0.25,
                    "mean_frame_delta": 2.0,
                },
                {
                    "profile": "asimov-1",
                    "ok": True,
                    "visual_progress": 0.5,
                    "mean_frame_delta": 4.0,
                },
            ],
        },
    )
    _write_json(
        run / "evidence" / "ALBERTA_END_TO_END_REPORT.json",
        {
            "ok": True,
            "production_complete": True,
            "video_review": {
                "video_count": 4,
                "profiles": ["asimov-1"],
                "manifest_review_consistent": True,
                "all_manifest_profiles_ok": True,
            },
            "backend_comparison": {"winner_by_mean_reward": "alberta"},
            "continual_obstacle_course": {
                "deltas": {
                    "alberta_acc_minus_ppo": 2.0,
                    "alberta_forgetting_minus_ppo": -0.5,
                }
            },
            "claim_support": {
                "evidence_consistent": True,
                "alberta_robot_backend_advantage_supported": True,
                "alberta_obstacle_advantage_supported": True,
                "production_claim_supported": True,
            },
        },
    )
    _write_json(
        run / "evidence" / "full_training_preflight" / "training_inputs_report.json",
        {
            "ok": True,
            "launch_tasks": ["stand_up"],
            "warnings": [{"kind": "no_offline_policy_datasets"}],
            "datasets": {
                "offline_datasets_present": False,
                "rl_from_sim_ready": True,
                "imitation_training_ready": False,
                "offline_datasets_block_current_plan": False,
            },
            "curriculum": {"content_sha256": "abc123"},
        },
    )

    report = generate_nebius_training_report(run)

    assert report["ok"] is True
    assert report["backend_comparison"]["winner_by_mean_reward"] == "alberta"
    assert report["backend_comparison"]["alberta_delta_vs_ppo"] == 1.0
    assert report["backend_comparison"]["untrained_mean_reward"] == 1.0
    assert report["backend_comparison"]["alberta_delta_vs_untrained"] == 2.0
    assert report["backend_comparison"]["ppo_delta_vs_untrained"] == 1.0
    assert report["continual_learning"]["obstacle_course"]["alberta_forgetting"] == 0.0
    assert (
        report["continual_learning"]["obstacle_course"]["alberta_acc_delta_vs_ppo"]
        == 2.0
    )
    assert (
        report["obstacle_generalization"][
            "alberta_no_catastrophic_forgetting_observed"
        ]
        is True
    )
    assert (
        report["obstacle_generalization"]["alberta_forgetting_not_worse_than_ppo"]
        is True
    )
    assert (
        report["method_matrix"]["alberta_streaming"]["role"]
        == "default continual online robot learner"
    )
    assert report["method_matrix"]["stable_baselines3_ppo"]["robot_mean_reward"] == 2.0
    assert report["method_matrix"]["untrained_policy"]["artifact_present"] is True
    assert report["method_matrix"]["untrained_policy"]["robot_mean_reward"] == 1.0
    assert report["method_matrix"]["untrained_policy"]["robot_delta_vs_alberta"] == -2.0
    assert report["method_matrix"]["brax_mjx_ppo"]["artifact_present"] is True
    assert report["sota_baseline"]["regime"] == "brax_ppo"
    assert report["video_review"]["video_count"] == 4
    assert report["video_review"]["action_progress"]["profiles"] == ["asimov-1"]
    assert report["video_review"]["action_progress"]["ok_video_count"] == 2
    assert report["video_review"]["action_progress"]["min_visual_progress"] == 0.25
    assert report["video_review"]["action_progress"]["mean_visual_progress"] == 0.375
    assert report["video_review"]["action_progress"]["mean_frame_delta"] == 3.0
    assert report["alberta_end_to_end_report"]["present"] is True
    assert report["alberta_end_to_end_report"]["ok"] is True
    assert report["alberta_end_to_end_report"]["production_complete"] is True
    assert report["alberta_end_to_end_report"]["video_count"] == 4
    assert report["alberta_end_to_end_report"]["backend_winner"] == "alberta"
    assert report["alberta_end_to_end_report"]["obstacle_acc_delta"] == 2.0
    assert (
        report["alberta_end_to_end_report"]["video_manifest_review_consistent"]
        is True
    )
    assert report["alberta_end_to_end_report"]["video_all_manifest_profiles_ok"] is True
    assert (
        report["alberta_end_to_end_report"]["claim_support"][
            "alberta_robot_backend_advantage_supported"
        ]
        is True
    )
    assert report["multi_robot_video_manifest"]["profile_count"] == 2
    assert report["multi_robot_video_manifest"]["ok_profile_count"] == 2
    assert report["multi_robot_video_manifest"]["profiles"][0]["profile"] == "asimov-1"
    assert (
        report["multi_robot_video_manifest"]["profiles"][0]["combined_present"]
        is True
    )
    assert report["training_inputs"]["ok"] is True
    assert report["training_inputs"]["offline_datasets_present"] is False
    assert report["training_inputs"]["rl_from_sim_ready"] is True
    assert report["training_inputs"]["imitation_training_ready"] is False
    assert report["training_inputs"]["offline_datasets_block_current_plan"] is False
    assert report["validation_gates"]["stage_status"]["ok"] is True
    assert report["validation_gates"]["backend_comparison"]["checks"][
        "winner_consistent"
    ] is True
    assert report["validation_gates"]["joint_reach_benchmark"]["required_deltas"][
        "require_alberta_acc_gte_ppo"
    ] is True
    assert report["validation_gates"]["video_review"]["thresholds"][
        "min_visual_progress"
    ] == 0.0001
    assert report["completion_requirements"]["stage_status_ok"] is True
    assert report["completion_requirements"]["runner_status_complete"] is True
    assert report["completion_requirements"]["stage_status_all_complete"] is True
    assert report["completion_requirements"]["training_inputs_ok"] is True
    assert report["completion_requirements"]["training_inputs_present"] is True
    assert (
        report["completion_requirements"][
            "training_inputs_launch_tasks_cover_requested"
        ]
        is True
    )
    assert report["completion_requirements"]["training_inputs_no_blockers"] is True
    assert report["completion_requirements"]["training_inputs_curriculum_hash"] is True
    assert report["completion_requirements"]["training_inputs_rl_from_sim_ready"] is True
    assert (
        report["completion_requirements"][
            "training_inputs_offline_datasets_not_blocking"
        ]
        is True
    )
    assert report["completion_requirements"]["multi_robot_readiness_ok"] is True
    assert report["completion_requirements"]["multi_robot_video_evidence_ok"] is True
    assert (
        report["completion_requirements"]["multi_robot_combined_videos_required"]
        is True
    )
    assert report["completion_requirements"]["multi_robot_video_commands_match"] is True
    assert (
        report["completion_requirements"][
            "multi_robot_video_combined_recording_match"
        ]
        is True
    )
    assert report["completion_requirements"]["video_review_ok"] is True
    assert report["completion_requirements"]["alberta_end_to_end_report_present"] is True
    assert report["completion_requirements"]["alberta_end_to_end_report_ok"] is True
    assert (
        report["completion_requirements"]["alberta_end_to_end_report_video_count_matches"]
        is True
    )
    assert (
        report["completion_requirements"][
            "alberta_end_to_end_report_video_manifest_consistent"
        ]
        is True
    )
    assert (
        report["completion_requirements"][
            "alberta_end_to_end_report_evidence_consistent"
        ]
        is True
    )
    assert (
        report["completion_requirements"][
            "alberta_end_to_end_report_robot_advantage_supported"
        ]
        is True
    )
    assert (
        report["completion_requirements"][
            "alberta_end_to_end_report_obstacle_advantage_supported"
        ]
        is True
    )
    assert (
        report["completion_requirements"][
            "alberta_end_to_end_report_production_claim_supported"
        ]
        is True
    )
    assert report["completion_requirements"]["video_action_progress_ok"] is True
    assert report["completion_requirements"]["video_min_visual_progress_met"] is True
    assert report["completion_requirements"]["video_all_reviewed_ok"] is True
    assert report["completion_requirements"]["production_policy_videos_ok"] is True
    assert (
        report["completion_requirements"][
            "production_policy_videos_checkpoint_bound"
        ]
        is True
    )
    assert (
        report["completion_requirements"][
            "production_policy_videos_checkpoint_exists"
        ]
        is True
    )
    assert (
        report["completion_requirements"][
            "production_policy_videos_expected_actions"
        ]
        is True
    )
    assert report["completion_requirements"]["instance_launch_hygiene_ok"] is True
    assert (
        report["completion_requirements"]["instance_launch_no_inline_credentials"]
        is True
    )
    assert report["completion_requirements"]["instance_launch_repo_stage_runner"] is True
    assert report["completion_requirements"]["instance_launch_training_s3_uri"] is True
    assert (
        report["completion_requirements"]["instance_launch_heartbeat_upload_contract"]
        is True
    )
    assert (
        report["completion_requirements"]["joint_reach_alberta_acc_gte_ppo"]
        is True
    )
    assert (
        report["completion_requirements"][
            "joint_reach_alberta_forgetting_lte_ppo"
        ]
        is True
    )
    assert report["completion_requirements"]["joint_reach_task_matrix_ok"] is True
    assert (
        report["completion_requirements"]["joint_reach_exact_learner_seed_grid"]
        is True
    )
    assert (
        report["completion_requirements"][
            "obstacle_course_alberta_acc_gte_ppo"
        ]
        is True
    )
    assert (
        report["completion_requirements"][
            "obstacle_course_alberta_forgetting_lte_ppo"
        ]
        is True
    )
    assert report["completion_requirements"]["obstacle_course_task_matrix_ok"] is True
    assert (
        report["completion_requirements"][
            "obstacle_course_exact_learner_seed_grid"
        ]
        is True
    )
    assert report["completion_requirements"]["alberta_checkpoint_ok"] is True
    assert (
        report["completion_requirements"]["alberta_checkpoint_regime_streaming"]
        is True
    )
    assert (
        report["completion_requirements"]["alberta_checkpoint_profile_matches"]
        is True
    )
    assert report["completion_requirements"]["alberta_checkpoint_required_tasks"] is True
    assert report["completion_requirements"]["alberta_checkpoint_domain_rand"] is True
    assert report["completion_requirements"]["alberta_checkpoint_total_steps"] is True
    assert report["completion_requirements"]["alberta_checkpoint_inference"] is True
    assert report["completion_requirements"]["asimov1_alberta_production_ok"] is True
    assert (
        report["completion_requirements"]["asimov1_alberta_regime_streaming"]
        is True
    )
    assert report["completion_requirements"]["asimov1_alberta_required_tasks"] is True
    assert report["completion_requirements"]["asimov1_alberta_asset_provenance"] is True
    assert report["completion_requirements"]["asimov1_alberta_inference_check"] is True
    assert report["completion_requirements"]["brax_mjx_baseline_present"] is True
    assert report["completion_requirements"]["brax_full_training_run_ok"] is True
    assert report["completion_requirements"]["brax_production_checkpoint_ok"] is True
    assert report["completion_requirements"]["brax_regime_ppo"] is True
    assert report["completion_requirements"]["brax_profile_matches"] is True
    assert report["completion_requirements"]["brax_total_steps_present"] is True
    assert (
        report["completion_requirements"]["backend_alberta_vs_ppo_delta_ok"]
        is True
    )
    assert (
        report["completion_requirements"]["backend_alberta_delta_vs_untrained_ok"]
        is True
    )
    assert (
        report["completion_requirements"]["backend_ppo_delta_vs_untrained_ok"]
        is True
    )
    assert report["completion_requirements"]["backend_eval_config_ok"] is True
    assert report["completion_requirements"]["backend_winner_consistent"] is True
    assert report["completion_requirements"]["backend_eval_rollout_depth_ok"] is True
    assert all(report["completion_requirements"].values())


def test_generate_nebius_training_report_marks_missing_artifacts(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "monitor_status.json", {"run_id": "robot-full-test", "state": "running"})
    _write_json(run / "validation_report.json", {"run_id": "robot-full-test", "ok": False})
    _write_json(
        run / "finalization_report.json",
        {"ok": False, "missing_gates": ["backend_comparison"]},
    )

    report = generate_nebius_training_report(run)
    write_markdown(report, run / "report.md")

    assert report["ok"] is False
    assert not all(report["completion_requirements"].values())
    assert report["backend_comparison"]["present"] is False
    assert report["missing_gates"] == ["backend_comparison"]
    markdown = (run / "report.md").read_text()
    assert "not-complete" in markdown
    assert "Method Matrix" in markdown
    assert "Obstacle Generalization And Forgetting" in markdown
    assert "Minimum visual progress" in markdown
    assert "Alberta End-to-End Evidence Bundle" in markdown
    assert "Multi-Robot Video Manifest" in markdown
    assert "Training Inputs And Text Conditioning" in markdown
    assert "Validation Gate Details" in markdown
    assert "multi_robot_readiness" in markdown
    assert "alberta_checkpoint" in markdown
    assert "asimov1_alberta_production" in markdown
    assert "brax_production_checkpoint" in markdown
    assert "production_policy_videos" in markdown
    assert "Completion Requirements" in markdown


def test_generate_nebius_training_report_does_not_treat_booleans_as_numbers(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "monitor_status.json", {"run_id": "robot-full-test", "state": "complete"})
    _write_json(
        run / "validation_report.json",
        {
            "run_id": "robot-full-test",
            "ok": True,
            "reports": {
                "training_inputs": {
                    "ok": True,
                    "checks": {
                        "present": True,
                        "launch_tasks_cover_requested": True,
                        "no_blockers": True,
                        "curriculum_hash": True,
                        "rl_from_sim_ready": True,
                        "offline_datasets_not_blocking_current_plan": True,
                    },
                },
                "multi_robot_readiness": {
                    "ok": True,
                    "video_evidence": {
                        "ok": True,
                        "commands_match": True,
                        "combined_recording_match": True,
                        "require_combined": True,
                    },
                },
                "backend_comparison": {
                    "ok": True,
                    "checks": {
                        "alberta_vs_ppo_delta": True,
                        "alberta_delta_vs_untrained": True,
                        "ppo_delta_vs_untrained": True,
                        "eval_config": True,
                        "winner_consistent": True,
                    },
                },
                "joint_reach_benchmark": {
                    "ok": True,
                    "checks": {
                        "tasks": True,
                        "result_count": True,
                        "learner_seed_pairs": True,
                        "learner_seed_coverage": True,
                        "matrix_shapes": True,
                        "alberta_acc_gte_ppo": True,
                        "alberta_forgetting_lte_ppo": True,
                    },
                },
                "obstacle_course_benchmark": {
                    "ok": True,
                    "checks": {
                        "tasks": True,
                        "result_count": True,
                        "learner_seed_pairs": True,
                        "learner_seed_coverage": True,
                        "matrix_shapes": True,
                        "alberta_acc_gte_ppo": True,
                        "alberta_forgetting_lte_ppo": True,
                    },
                },
                "alberta_checkpoint": {
                    "ok": True,
                    "checks": {
                        "regime": True,
                        "profile_id": True,
                        "required_tasks": True,
                        "domain_rand": True,
                        "total_steps": True,
                        "inference": True,
                    },
                },
                "asimov1_alberta_production": {
                    "ok": True,
                    "production_regime": "alberta_streaming",
                    "checks": {
                        "required_tasks": True,
                        "manifest_mjcf_asset_provenance": True,
                        "manifest_asset_manifest_provenance": True,
                        "inference_check": True,
                    },
                },
                "brax_full_training_run": {"ok": True, "checks": {}},
                "brax_production_checkpoint": {"ok": True, "checks": {}},
                "video_review": {
                    "ok": True,
                    "thresholds": {"min_visual_progress": 0.0001},
                },
                "production_policy_videos": {
                    "ok": True,
                    "checks": {
                        "checkpoint_exists": True,
                        "manifest_policy_checkpoint": True,
                        "profile_policy_checkpoint": True,
                        "expected_videos": True,
                        "video_sizes": True,
                        "expected_telemetry": True,
                        "telemetry_sizes": True,
                        "combined_video": True,
                    },
                },
            },
        },
    )
    _write_json(run / "finalization_report.json", {"ok": True, "missing_gates": []})
    _write_json(
        run / "evidence" / "backend_compare" / "asimov-1" / "comparison.json",
        {
            "profile_id": "asimov-1",
            "tasks": ["stand_up"],
            "steps": 30000,
            "winner_by_mean_reward": "alberta",
            "baseline": {"mean_reward_overall": 1.0},
            "alberta": {"eval": {"mean_reward_overall": True}},
            "ppo": {"eval": {"mean_reward_overall": 2.0}},
        },
    )
    _write_json(
        run / "evidence" / "alberta_joint_reach" / "continual_benchmark.json",
        {
            "summary": {
                "alberta": {"acc": {"mean": True}, "forgetting": {"mean": 0.0}},
                "ppo": {"acc": {"mean": 2.0}, "forgetting": {"mean": 0.5}},
            }
        },
    )
    _write_json(
        run / "evidence" / "alberta_obstacle_course" / "continual_benchmark.json",
        {
            "summary": {
                "alberta": {"acc": {"mean": 4.0}, "forgetting": {"mean": True}},
                "ppo": {"acc": {"mean": 2.0}, "forgetting": {"mean": 0.5}},
            }
        },
    )
    _write_json(
        run / "evidence" / "full_training_preflight" / "asimov_1_brax_mjx_baseline" / "manifest.json",
        {"regime": "brax_ppo", "total_steps": True, "profile_id": "asimov-1"},
    )
    _write_json(
        run / "evidence" / "video_review_production" / "video_review.json",
        {
            "ok": True,
            "video_count": 1,
            "videos": [
                {
                    "profile": "asimov-1",
                    "ok": True,
                    "visual_progress": True,
                    "mean_frame_delta": 2.0,
                }
            ],
        },
    )
    _write_json(
        run / "evidence" / "full_training_preflight" / "training_inputs_report.json",
        {
            "ok": True,
            "launch_tasks": ["stand_up"],
            "curriculum": {"content_sha256": "abc123"},
        },
    )

    report = generate_nebius_training_report(run)
    write_markdown(report, run / "report.md")

    assert report["backend_comparison"]["alberta_delta_vs_ppo"] is None
    assert report["continual_learning"]["joint_reach"]["alberta_acc_delta_vs_ppo"] is None
    assert (
        report["obstacle_generalization"]["alberta_no_catastrophic_forgetting_observed"]
        is False
    )
    assert report["video_review"]["action_progress"]["min_visual_progress"] is None
    assert report["completion_requirements"]["brax_total_steps_present"] is False
    assert report["completion_requirements"]["video_action_progress_ok"] is False
    markdown = (run / "report.md").read_text()
    assert "| mean reward | `True` | `2.0000` |" in markdown
    assert "Steps: `True`" in markdown


def test_generate_nebius_training_report_cli_returns_two_for_incomplete(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "finalization_report.json", {"ok": False})

    assert main([str(run)]) == 2
    assert (run / "training_comparison_report.json").is_file()
    assert (run / "training_comparison_report.md").is_file()
