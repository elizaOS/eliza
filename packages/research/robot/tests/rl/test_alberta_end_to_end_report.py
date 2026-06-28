from __future__ import annotations

import json
from pathlib import Path

from scripts.generate_alberta_end_to_end_report import generate_report


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"contact")


def _write_bytes(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def test_generate_alberta_end_to_end_report_uses_current_evidence(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    _write_json(
        package / "evidence" / "backend_compare_smoke" / "validation_report.json",
        {
            "ok": True,
            "deltas": {
                "baseline_mean_reward": 0.5,
                "alberta_mean_reward": 2.0,
                "ppo_mean_reward": 1.0,
                "alberta_minus_untrained_mean_reward": 1.5,
                "ppo_minus_untrained_mean_reward": 0.5,
            },
            "survival": {"min_mean_steps_survived": 20.0},
            "checks": {"winner_consistent": True},
        },
    )
    _write_json(
        package / "evidence" / "backend_compare_smoke" / "comparison.json",
        {
            "profile_id": "asimov-1",
            "tasks": ["stand_up"],
            "steps": 64,
            "winner_by_mean_reward": "alberta",
            "alberta_vs_ppo_delta": {"mean_reward_overall": 1.0},
        },
    )
    _write_json(
        package / "evidence" / "backend_compare_smoke" / "alberta_validation_report.json",
        {
            "ok": True,
            "checkpoint": str(package / "evidence" / "backend_compare_smoke" / "alberta"),
            "profile_id": "asimov-1",
            "total_steps": 64,
            "requested_total_steps": 64,
            "checks": {
                "regime": True,
                "profile_id": True,
                "required_tasks": True,
                "domain_rand": True,
                "controller": True,
                "history": True,
                "inference": True,
            },
            "inference_report": {
                "ok": True,
                "results": [
                    {"prompt": "stand up", "matched_task": "stand_up", "shape": [25], "finite": True}
                ],
            },
        },
    )
    _write_json(
        package / "evidence" / "alberta_all_profiles" / "unitree-r1" / "alberta_validation_report.json",
        {
            "ok": True,
            "checkpoint": str(package / "evidence" / "alberta_all_profiles" / "unitree-r1" / "alberta"),
            "profile_id": "unitree-r1",
            "total_steps": 6,
            "requested_total_steps": 6,
            "checks": {
                "regime": True,
                "profile_id": True,
                "required_tasks": True,
                "domain_rand": True,
                "controller": True,
                "history": True,
                "inference": True,
            },
            "inference_report": {
                "ok": True,
                "results": [
                    {"prompt": "walk forward", "matched_task": "walk_forward", "shape": [29], "finite": True}
                ],
            },
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_smoke" / "validation_report.json",
        {
            "ok": True,
            "deltas": {
                "alberta_acc_minus_ppo": 0.5,
                "alberta_forgetting_minus_ppo": -0.1,
            },
            "checks": {"alberta_acc_gte_ppo": True},
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_smoke" / "continual_benchmark.json",
        {
            "config": {
                "env_kind": "obstacle_course",
                "n_tasks": 4,
                "steps_per_task": 2500,
                "eval_episodes": 3,
                "seeds": 1,
            },
            "summary": {
                "alberta": {
                    "acc": {"mean": 2.0},
                    "bwt": {"mean": 0.0},
                    "forgetting": {"mean": 0.0},
                    "fwt": {"mean": 0.0},
                },
                "ppo": {
                    "acc": {"mean": 1.5},
                    "bwt": {"mean": -0.1},
                    "forgetting": {"mean": 0.1},
                    "fwt": {"mean": 0.2},
                },
            },
            "results": [
                {
                    "name": "alberta",
                    "seed": 1000,
                    "baseline": [0.0, 0.0, 0.0, 0.0],
                    "matrix": [
                        [1.0, 0.0, 0.0, 0.0],
                        [1.0, 1.5, 0.0, 0.0],
                        [1.0, 1.5, 2.0, 0.0],
                        [1.0, 1.5, 2.0, 2.5],
                    ],
                },
                {
                    "name": "ppo",
                    "seed": 1000,
                    "baseline": [0.0, 0.0, 0.0, 0.0],
                    "matrix": [
                        [1.0, 0.0, 0.0, 0.0],
                        [0.3, 1.0, 0.0, 0.0],
                        [0.2, 0.4, 1.0, 0.0],
                        [0.1, 0.2, 0.3, 1.0],
                    ],
                },
            ],
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_smoke" / "obstacle_course_demo.json",
        {
            "ok": True,
            "video": str(package / "evidence" / "alberta_obstacle_course_smoke" / "obstacle_course_demo.mp4"),
            "video_bytes": 1234,
            "frames": 8,
            "visual_review": {"verdict": "good", "contact_sheet": "contact.jpg"},
        },
    )
    _write_bytes(package / "evidence" / "alberta_obstacle_course_smoke" / "obstacle_course_demo.mp4", 1234)
    _touch(package / "contact.jpg")
    _write_json(
        package / "evidence" / "alberta_obstacle_course_sac_smoke" / "continual_benchmark.json",
        {
            "config": {
                "env_kind": "obstacle_course",
                "n_tasks": 2,
                "steps_per_task": 40,
                "eval_episodes": 1,
                "learners": ["alberta", "ppo", "sac"],
            },
            "summary": {
                "alberta": {"acc": {"mean": 1.0}, "forgetting": {"mean": 0.0}},
                "ppo": {"acc": {"mean": 0.8}, "forgetting": {"mean": 0.2}},
                "sac": {"acc": {"mean": 0.3}, "forgetting": {"mean": 0.0}},
            },
            "results": [
                {
                    "name": "alberta",
                    "seed": 1000,
                    "baseline": [0.0, 0.0],
                    "matrix": [[1.0, 0.0], [1.0, 1.2]],
                },
                {
                    "name": "ppo",
                    "seed": 1000,
                    "baseline": [0.0, 0.0],
                    "matrix": [[0.8, 0.0], [0.2, 0.8]],
                },
                {
                    "name": "sac",
                    "seed": 1000,
                    "baseline": [0.0, 0.0],
                    "matrix": [[0.3, 0.0], [0.3, 0.3]],
                },
            ],
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_sac_smoke" / "validation_report.json",
        {
            "ok": True,
            "configured_learners": ["alberta", "ppo", "sac"],
            "checks": {"metrics": True},
            "deltas": {
                "alberta_acc_minus_ppo": 0.2,
                "alberta_forgetting_minus_ppo": -0.2,
            },
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_sac_smoke" / "obstacle_course_demo.json",
        {
            "ok": True,
            "video": "sac-demo.mp4",
            "video_bytes": 456,
            "frames": 6,
            "learners": ["alberta", "ppo", "sac"],
            "visual_review": {"verdict": "good", "contact_sheet": "sac-contact.jpg"},
        },
    )
    _write_bytes(package / "sac-demo.mp4", 456)
    _touch(package / "sac-contact.jpg")
    _write_json(
        package / "evidence" / "video_review" / "video_review.json",
        {
            "ok": True,
            "video_count": 5,
            "profiles": ["asimov-1"],
            "actions": ["combined_actions", "stand_up"],
            "all_videos_reviewed_good": True,
            "manual_annotations": {"count": 0},
            "min_visual_progress": 0.2,
            "mean_visual_progress": 0.3,
            "videos": [
                {
                    "profile": "asimov-1",
                    "action": "stand_up",
                    "video": "asimov-1/stand_up.mp4",
                    "contact_sheet": "contact-stand-up.jpg",
                    "verdict": "good",
                    "review_notes": "sampled frames show motion",
                    "frame_count": 40,
                    "visual_progress": 0.2,
                    "telemetry": {"ok": True},
                }
            ],
        },
    )
    _touch(package / "contact-stand-up.jpg")
    _write_json(
        package / "evidence" / "agent_videos" / "manifest.json",
        {
            "ok": True,
            "profiles": [
                {
                    "profile": "asimov-1",
                    "videos": ["a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4"],
                    "expected_videos": ["a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4"],
                    "missing_videos": [],
                    "combined_present": True,
                    "ok": True,
                }
            ],
        },
    )
    for profile in ("asimov-1", "unitree-r1"):
        checkpoint = package / "evidence" / "alberta_all_profiles" / profile / "alberta"
        checkpoint.mkdir(parents=True, exist_ok=True)
    _write_json(
        package / "evidence" / "alberta_checkpoint_videos" / "manifest.json",
        {
            "ok": True,
            "profiles": [
                {
                    "profile": "asimov-1",
                    "videos": ["asimov-1_stand_up.mp4", "asimov-1_walk_forward.mp4", "asimov-1_combined_actions.mp4"],
                    "telemetry": [
                        "asimov-1_stand_up.telemetry.json",
                        "asimov-1_walk_forward.telemetry.json",
                        "asimov-1_combined_actions.telemetry.json",
                    ],
                    "combined_present": True,
                    "policy_checkpoint": str((package / "evidence" / "alberta_all_profiles" / "asimov-1" / "alberta").resolve()),
                    "ok": True,
                },
                {
                    "profile": "unitree-r1",
                    "videos": ["unitree-r1_stand_up.mp4", "unitree-r1_walk_forward.mp4", "unitree-r1_combined_actions.mp4"],
                    "telemetry": [
                        "unitree-r1_stand_up.telemetry.json",
                        "unitree-r1_walk_forward.telemetry.json",
                        "unitree-r1_combined_actions.telemetry.json",
                    ],
                    "combined_present": True,
                    "policy_checkpoint": str((package / "evidence" / "alberta_all_profiles" / "unitree-r1" / "alberta").resolve()),
                    "ok": True,
                },
            ],
        },
    )
    _write_json(
        package / "evidence" / "alberta_checkpoint_video_review" / "video_review.json",
        {
            "ok": True,
            "video_count": 6,
            "profiles": ["asimov-1", "unitree-r1"],
            "actions": ["combined_actions", "stand_up", "walk_forward"],
            "all_videos_reviewed_good": True,
            "telemetry": {"present_count": 6, "ok_count": 6, "failed_count": 0},
            "min_visual_progress": 0.1,
            "mean_visual_progress": 0.2,
            "videos": [
                {
                    "profile": "asimov-1",
                    "action": "stand_up",
                    "video": "asimov-1/stand_up.mp4",
                    "contact_sheet": "checkpoint-contact.jpg",
                    "verdict": "good",
                    "review_notes": "checkpoint sampled frames show motion",
                    "frame_count": 30,
                    "visual_progress": 0.1,
                    "telemetry": {"ok": True},
                },
                *[
                    {
                        "profile": "unitree-r1",
                        "action": "walk_forward",
                        "video": f"unitree-r1/walk_forward_{idx}.mp4",
                        "contact_sheet": f"checkpoint-contact-{idx}.jpg",
                        "verdict": "good",
                        "review_notes": "checkpoint sampled frames show motion",
                        "frame_count": 30,
                        "visual_progress": 0.1,
                        "telemetry": {"ok": True},
                    }
                    for idx in range(5)
                ],
            ],
        },
    )
    _touch(package / "checkpoint-contact.jpg")
    for idx in range(5):
        _touch(package / f"checkpoint-contact-{idx}.jpg")
    _write_json(
        package / "evidence" / "alberta_checkpoint_video_review" / "validation_report.json",
        {
            "ok": True,
            "checks": {"manifest": True, "manifest_ok": True, "profiles": True, "review": True, "videos": True},
            "video_reports": [{"policy_source_ok": True, "task_signal_ok": True} for _ in range(6)],
        },
    )
    _write_json(
        package / "evidence" / "alberta_objective_completion_audit.json",
        {
            "ok": False,
            "passed": ["alberta_framework_integrated"],
            "failed": ["nebius_production_training_complete"],
        },
    )
    _write_json(
        package / "evidence" / "alberta_integration_surfaces.json",
        {
            "ok": True,
            "checks": {
                "dependency": True,
                "source_override": True,
                "modules": True,
                "public_exports": True,
                "console_scripts": True,
                "files": True,
            },
            "console_scripts": {"eliza-robot-train-alberta": True},
            "public_exports": {"AlbertaContinualController": True},
        },
    )
    _write_json(
        package / "evidence" / "nebius_full_training" / "clean_launch_status.json",
        {"nebius_auth": {"reason": "nebius_cli_auth_required"}},
    )
    _write_json(
        package / "evidence" / "full_training_preflight" / "preflight_report.json",
        {
            "brax_validation": {"ok": True},
            "training_inputs_valid": True,
            "scripts": {"brax_baseline": str(package / "brax.sh")},
        },
    )
    _write_json(
        package / "evidence" / "brax_mjx_contract_artifact" / "validation_report.json",
        {
            "ok": True,
            "contract_only": True,
            "production_training": False,
            "checks": {
                "policy_artifact": True,
                "manifest": True,
                "metrics": True,
                "config": True,
                "regime": True,
                "profile_id": True,
                "asymmetric_actor_critic": True,
                "contract_not_production": True,
            },
            "manifest": {
                "regime": "brax_ppo",
                "profile_id": "asimov-1",
                "total_steps": 8,
            },
        },
    )
    _write_json(
        package / "evidence" / "full_training_preflight" / "training_inputs_report.json",
        {
            "ok": True,
            "launch_tasks": ["stand_up", "walk_forward"],
            "curriculum": {
                "version": "test",
                "task_count": 2,
                "content_sha256": "abc123",
                "text_variant_collisions": [],
            },
            "tasks": [
                {
                    "task_id": "stand_up",
                    "in_launch_tasks": True,
                    "supported_by_profile_env": True,
                },
                {
                    "task_id": "walk_forward",
                    "in_launch_tasks": True,
                    "supported_by_profile_env": True,
                },
            ],
            "profiles": [
                {"profile_id": "asimov-1", "ok": True},
                {"profile_id": "unitree-r1", "ok": True},
            ],
            "datasets": {
                "rl_from_sim_ready": True,
                "offline_datasets_present": False,
                "imitation_training_ready": False,
                "offline_datasets_block_current_plan": False,
                "training_source": "RL-from-simulation",
                "trajectory_db_tooling_present": True,
            },
            "blockers": [],
            "warnings": [{"kind": "no_offline_policy_datasets"}],
        },
    )
    _write_json(
        package / "evidence" / "local_validation" / "alberta_robot_validation_summary.json",
        {
            "ok": True,
            "junit_xml": "evidence/local_validation/alberta_robot_validation.xml",
            "tests": 12,
            "passed": 12,
            "failures": 0,
            "errors": 0,
            "skipped": 0,
            "time_seconds": 1.5,
            "known_warnings": ["known warning"],
            "coverage_scope": ["Alberta tests", "Nebius validators"],
        },
    )
    (package / "brax.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")

    report = generate_report(
        package_root=package,
        out_json=package / "evidence" / "report.json",
        out_md=package / "evidence" / "report.md",
    )

    assert report["ok"] is True
    assert report["production_complete"] is False
    assert report["production_blocker"] == "nebius_cli_auth_required"
    assert report["backend_comparison"]["alberta_minus_ppo_mean_reward"] == 1.0
    assert report["backend_comparison"]["baseline_mean_reward"] == 0.5
    assert report["backend_comparison"]["alberta_minus_untrained_mean_reward"] == 1.5
    assert report["backend_comparison"]["ppo_minus_untrained_mean_reward"] == 0.5
    assert report["backend_comparison"]["alberta_gte_ppo_by_mean_reward"] is True
    assert report["robot_backend_comparisons"]["ok_count"] == 1
    assert report["robot_backend_comparisons"]["profiles"] == ["asimov-1"]
    assert report["robot_backend_comparisons"]["any_alberta_gte_ppo_by_mean_reward"] is True
    assert report["sota_baselines"]["stable_baselines3_ppo"][
        "local_comparison_artifact_present"
    ] is False
    assert report["sota_baselines"]["brax_mjx_ppo"]["preflight_validation_ok"] is True
    assert report["sota_baselines"]["brax_mjx_ppo"]["script_present"] is True
    assert report["sota_baselines"]["brax_mjx_ppo"]["contract_artifact_ok"] is True
    assert report["sota_baselines"]["brax_mjx_ppo"]["contract_only"] is True
    assert report["sota_baselines"]["brax_mjx_ppo"]["production_training"] is False
    assert report["sota_baselines"]["brax_mjx_ppo"]["contract_regime"] == "brax_ppo"
    assert report["sota_baselines"]["brax_mjx_ppo"]["contract_profile_id"] == "asimov-1"
    assert report["sota_baselines"]["brax_mjx_ppo"]["contract_steps"] == 8
    assert report["training_inputs"]["ok"] is True
    assert report["training_inputs"]["launch_task_count"] == 2
    assert report["training_inputs"]["supported_launch_task_count"] == 2
    assert report["training_inputs"]["ready_profile_count"] == 2
    assert report["training_inputs"]["rl_from_sim_ready"] is True
    assert report["training_inputs"]["offline_datasets_present"] is False
    assert report["training_inputs"]["offline_datasets_block_current_plan"] is False
    assert report["training_inputs"]["warning_kinds"] == ["no_offline_policy_datasets"]
    assert report["alberta_checkpoints"]["count"] == 2
    assert report["alberta_checkpoints"]["ok_count"] == 2
    assert report["alberta_checkpoints"]["profiles"] == ["asimov-1", "unitree-r1"]
    assert report["alberta_checkpoints"]["all_inference_ok"] is True
    assert report["local_validation"]["ok"] is True
    assert report["local_validation"]["tests"] == 12
    assert report["local_validation"]["passed"] == 12
    assert report["local_validation"]["failures"] == 0
    assert report["local_validation"]["coverage_scope"] == ["Alberta tests", "Nebius validators"]
    sac = report["optional_sota_comparisons"]["stable_baselines3_sac"]
    assert sac["present"] is True
    assert sac["ok"] is True
    assert sac["learners"] == ["alberta", "ppo", "sac"]
    assert sac["acc"]["sac"] == 0.3
    assert sac["deltas"]["alberta_acc_minus_ppo"] == 0.2
    assert sac["deltas"]["alberta_acc_minus_sac"] == 0.7
    assert sac["deltas"]["alberta_forgetting_minus_sac"] == 0.0
    assert sac["deltas"]["alberta_new_task_gain_minus_sac"] == 0.8
    assert sac["deltas"]["alberta_acc_gte_sac"] is True
    assert sac["deltas"]["alberta_forgetting_lte_sac"] is True
    assert sac["deltas"]["alberta_new_task_gain_gte_sac"] is True
    assert sac["deltas"]["alberta_vs_sac_advantage_supported"] is True
    assert sac["adaptation"]["alberta"]["mean_new_task_gain"] == 1.1
    assert sac["demo"]["ok"] is True
    assert sac["demo"]["learners"] == ["alberta", "ppo", "sac"]
    assert sac["demo"]["visual_review"]["verdict"] == "good"
    assert sac["demo"]["artifacts"]["video_present"] is True
    assert sac["demo"]["artifacts"]["video_bytes_match"] is True
    assert sac["demo"]["artifacts"]["contact_sheet_exists"] is True
    assert report["backend_comparison"]["survival"]["min_mean_steps_survived"] == 20.0
    assert report["continual_obstacle_course"]["alberta_forgetting"] == 0.0
    assert report["continual_obstacle_course"]["adaptation"]["alberta"][
        "mean_new_task_gain"
    ] == 1.75
    assert report["continual_obstacle_course"]["adaptation"]["ppo"][
        "first_task_retention_delta"
    ] == -0.9
    assert report["continual_obstacle_course"]["n_tasks"] == 4
    assert report["continual_obstacle_course"]["eval_episodes"] == 3
    assert report["continual_obstacle_course"]["ppo_bwt"] == -0.1
    assert report["continual_obstacle_course"]["ppo_fwt"] == 0.2
    assert report["continual_obstacle_course"]["alberta_acc_gte_ppo"] is True
    assert report["continual_obstacle_course"]["alberta_forgetting_lte_ppo"] is True
    assert report["continual_obstacle_course"]["demo"]["ok"] is True
    assert report["continual_obstacle_course"]["demo"]["visual_review"]["verdict"] == "good"
    assert report["continual_obstacle_course"]["demo"]["artifacts"]["video_present"] is True
    assert report["continual_obstacle_course"]["demo"]["artifacts"]["video_bytes_match"] is True
    assert (
        report["continual_obstacle_course"]["demo"]["artifacts"]["contact_sheet_exists"]
        is True
    )
    assert report["video_review"]["video_count"] == 5
    assert report["video_review"]["manifest_video_count"] == 5
    assert report["video_review"]["expected_video_count"] == 5
    assert report["video_review"]["manifest_review_consistent"] is True
    assert report["video_review"]["actions"] == ["combined_actions", "stand_up"]
    assert report["video_review"]["all_videos_reviewed_good"] is True
    assert report["video_review"]["failed_review_count"] == 0
    assert report["video_review"]["review_artifacts"]["contact_sheet_count"] == 1
    assert report["video_review"]["review_artifacts"]["existing_contact_sheet_count"] == 1
    assert report["video_review"]["review_artifacts"]["missing_contact_sheet_count"] == 0
    assert report["video_review"]["review_artifacts"]["samples"][0]["contact_sheet"] == "contact-stand-up.jpg"
    assert report["video_review"]["review_artifacts"]["samples"][0]["contact_sheet_exists"] is True
    assert report["alberta_checkpoint_videos"]["ok"] is True
    assert report["alberta_checkpoint_videos"]["video_count"] == 6
    assert report["alberta_checkpoint_videos"]["checkpoint_mismatches"] == []
    assert report["alberta_checkpoint_videos"]["all_expected_reviewed"] is True
    assert report["alberta_checkpoint_videos"]["validation_ok"] is True
    assert report["alberta_checkpoint_videos"]["policy_source_ok_count"] == 6
    assert report["alberta_checkpoint_videos"]["task_signal_ok_count"] == 6
    assert report["alberta_checkpoint_videos"]["review_artifacts"]["contact_sheet_count"] == 6
    assert report["alberta_checkpoint_videos"]["review_artifacts"]["existing_contact_sheet_count"] == 6
    assert report["alberta_checkpoint_videos"]["review_artifacts"]["missing_contact_sheet_count"] == 0
    assert (
        report["alberta_checkpoint_videos"]["review_artifacts"]["samples"][0]["contact_sheet"]
        == "checkpoint-contact.jpg"
    )
    assert (
        report["alberta_checkpoint_videos"]["review_artifacts"]["samples"][0][
            "contact_sheet_exists"
        ]
        is True
    )
    assert report["scope"] == "local-smoke-and-preflight-evidence"
    assert report["schema"] == "robot-alberta-end-to-end-report-v1"
    assert report["claim_support"]["evidence_consistent"] is True
    assert report["claim_support"]["alberta_robot_backend_advantage_supported"] is True
    assert report["claim_support"]["all_robot_backend_comparisons_support_alberta"] is True
    assert report["claim_support"]["alberta_obstacle_advantage_supported"] is True
    assert report["claim_support"]["alberta_sac_obstacle_advantage_supported"] is True
    assert report["claim_support"]["checkpoint_bound_local_policy_videos_ok"] is True
    interpretation = report["comparison_interpretation"]
    assert interpretation["robot_backend_mean_reward"]["alberta_gte_ppo_count"] == 1
    assert interpretation["robot_backend_mean_reward"]["ppo_gt_alberta_count"] == 0
    assert interpretation["continual_obstacle_course"]["advantage_supported"] is True
    assert interpretation["sota_methods_compared"]["method_count"] == 4
    assert "stable-baselines3 SAC" in interpretation["sota_methods_compared"]["methods"]
    assert (
        "Brax/MJX PPO contract artifact"
        in interpretation["sota_methods_compared"]["methods"]
    )
    assert interpretation["sota_methods_compared"]["brax_mjx_contract_artifact_ok"] is True
    assert interpretation["sota_methods_compared"]["brax_mjx_contract_only"] is True
    assert interpretation["sota_methods_compared"]["brax_mjx_production_training"] is False
    assert interpretation["sota_methods_compared"]["alberta_vs_sac_acc_delta"] == 0.7
    assert (
        interpretation["sota_methods_compared"]["alberta_vs_sac_forgetting_delta"]
        == 0.0
    )
    assert (
        interpretation["sota_methods_compared"]["alberta_vs_sac_new_task_gain_delta"]
        == 0.8
    )
    assert (
        interpretation["sota_methods_compared"]["alberta_vs_sac_advantage_supported"]
        is True
    )
    requirements = report["objective_requirements"]
    assert requirements["alberta_framework_integrated"]["status"] == "proved"
    assert requirements["alberta_framework_integrated"]["evidence"][
        "integration_surfaces_ok"
    ] is True
    assert report["integration_surfaces"]["ok"] is True
    assert requirements["training_inputs_text_conditioning_and_datasets"]["status"] == "proved"
    assert requirements["alberta_checkpoint_inference_contract"]["status"] == "proved"
    assert requirements["alberta_checkpoint_inference_contract"]["evidence"][
        "all_ready_profiles_have_checkpoint_inference"
    ] is True
    assert requirements["local_test_validation_suite"]["status"] == "proved"
    assert requirements["traditional_and_sota_baselines"]["status"] == "partial"
    assert requirements["traditional_and_sota_baselines"]["evidence"][
        "brax_mjx_ppo_contract_artifact_ok"
    ] is True
    assert requirements["traditional_and_sota_baselines"]["evidence"][
        "brax_mjx_ppo_production_training"
    ] is False
    assert requirements["robot_action_videos_self_reviewed"]["status"] == "proved"
    assert requirements["robot_action_videos_self_reviewed"]["evidence"][
        "checkpoint_bound_local_policy_videos_ok"
    ] is True
    assert requirements["checkpoint_bound_local_policy_videos_reviewed"]["status"] == "proved"
    assert requirements["checkpoint_bound_local_policy_videos_reviewed"]["evidence"][
        "policy_source_ok_count"
    ] == 6
    assert requirements["checkpoint_bound_local_policy_videos_reviewed"]["evidence"][
        "task_signal_ok_count"
    ] == 6
    assert requirements["detailed_report_generated"]["status"] == "proved"
    assert requirements["nebius_production_training_complete"]["status"] == "missing"
    assert (package / "evidence" / "report.md").read_text(encoding="utf-8").startswith(
        "# Alberta End-to-End Evidence Report"
    )
    assert "## Objective Requirements" in (package / "evidence" / "report.md").read_text(
        encoding="utf-8"
    )
    assert "## Alberta Integration Surfaces" in (package / "evidence" / "report.md").read_text(
        encoding="utf-8"
    )
    assert "## Comparison Interpretation" in (package / "evidence" / "report.md").read_text(
        encoding="utf-8"
    )
    assert "## Checkpoint-Bound Alberta Videos" in (package / "evidence" / "report.md").read_text(
        encoding="utf-8"
    )


def test_generate_alberta_end_to_end_report_accepts_production_paths(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    backend_dir = package / "evidence" / "backend_compare" / "asimov-1"
    obstacle_dir = package / "evidence" / "alberta_obstacle_course"
    _write_json(
        backend_dir / "validation_report.json",
        {
            "ok": True,
            "deltas": {"alberta_mean_reward": 3.0, "ppo_mean_reward": 2.0},
            "checks": {"winner_consistent": True},
        },
    )
    _write_json(
        backend_dir / "comparison.json",
        {
            "profile_id": "asimov-1",
            "tasks": ["stand_up", "walk_forward"],
            "steps": 30000,
            "winner_by_mean_reward": "alberta",
            "alberta_vs_ppo_delta": {"mean_reward_overall": 1.0},
        },
    )
    _write_json(
        obstacle_dir / "validation_report.json",
        {
            "ok": True,
            "deltas": {
                "alberta_acc_minus_ppo": 2.0,
                "alberta_forgetting_minus_ppo": -0.5,
            },
            "checks": {"alberta_forgetting_lte_ppo": True},
        },
    )
    _write_json(
        obstacle_dir / "continual_benchmark.json",
        {
            "config": {
                "env_kind": "obstacle_course",
                "n_tasks": 4,
                "steps_per_task": 16000,
                "eval_episodes": 10,
                "seeds": 3,
            },
            "summary": {
                "alberta": {
                    "acc": {"mean": 4.0},
                    "bwt": {"mean": 0.0},
                    "forgetting": {"mean": 0.0},
                    "fwt": {"mean": 0.0},
                },
                "ppo": {
                    "acc": {"mean": 2.0},
                    "bwt": {"mean": -0.2},
                    "forgetting": {"mean": 0.5},
                    "fwt": {"mean": 0.1},
                },
            },
        },
    )
    _write_json(
        obstacle_dir / "obstacle_course_demo.json",
        {
            "ok": True,
            "video": str(obstacle_dir / "obstacle_course_demo.mp4"),
            "video_bytes": 999,
            "frames": 12,
        },
    )
    _write_json(
        package / "evidence" / "video_review" / "video_review.json",
        {
            "ok": True,
            "video_count": 1,
            "profiles": ["asimov-1"],
            "actions": ["stand_up"],
            "all_videos_reviewed_good": True,
            "manual_annotations": {"count": 0},
            "min_visual_progress": 0.2,
            "mean_visual_progress": 0.2,
            "videos": [
                {
                    "frame_count": 200,
                    "profile": "asimov-1",
                    "action": "stand_up",
                    "video": "asimov-1/asimov-1_stand_up.mp4",
                    "ok": True,
                    "verdict": "good",
                    "review_notes": "manual review found stable standing",
                    "failed_checks": [],
                }
            ],
        },
    )
    _write_json(
        package / "evidence" / "agent_videos" / "manifest.json",
        {
            "ok": True,
            "profiles": [
                {
                    "profile": "asimov-1",
                    "videos": ["asimov-1_stand_up.mp4"],
                    "expected_videos": ["asimov-1_stand_up.mp4"],
                    "missing_videos": [],
                    "combined_present": True,
                    "ok": True,
                }
            ],
        },
    )

    report = generate_report(
        package_root=package,
        backend_dir=backend_dir,
        backend_validation_path=backend_dir / "validation_report.json",
        obstacle_dir=obstacle_dir,
        obstacle_validation_path=obstacle_dir / "validation_report.json",
        video_review_path=package / "evidence" / "video_review" / "video_review.json",
        video_manifest_path=package / "evidence" / "agent_videos" / "manifest.json",
        scope="production-nebius-post-training",
        out_json=package / "evidence" / "report.json",
        out_md=package / "evidence" / "report.md",
    )

    assert report["ok"] is True
    assert report["scope"] == "production-nebius-post-training"
    assert report["backend_comparison"]["steps"] == 30000
    assert report["continual_obstacle_course"]["steps_per_task"] == 16000
    assert report["continual_obstacle_course"]["n_tasks"] == 4
    assert report["continual_obstacle_course"]["eval_episodes"] == 10
    assert report["continual_obstacle_course"]["deltas"]["alberta_forgetting_minus_ppo"] == -0.5
    assert report["continual_obstacle_course"]["demo"]["frames"] == 12
    assert report["video_review"]["min_frame_count"] == 200
    assert report["video_review"]["manifest_review_consistent"] is True
    assert report["video_review"]["all_videos_reviewed_good"] is True
    assert report["video_review"]["manual_annotation_count"] == 0
    assert report["video_review"]["failed_review_count"] == 0
    assert report["claim_support"]["alberta_robot_backend_advantage_supported"] is True
    assert report["claim_support"]["alberta_obstacle_advantage_supported"] is True
    assert report["sources"]["backend_dir"] == str(backend_dir)
    assert report["objective_requirements"]["detailed_report_generated"]["status"] == "proved"


def test_generate_alberta_end_to_end_report_rejects_video_manifest_mismatch(
    tmp_path: Path,
) -> None:
    package = tmp_path / "pkg"
    _write_json(
        package / "evidence" / "backend_compare_smoke" / "validation_report.json",
        {
            "ok": True,
            "deltas": {"alberta_mean_reward": 2.0, "ppo_mean_reward": 1.0},
            "checks": {"winner_consistent": True},
        },
    )
    _write_json(
        package / "evidence" / "backend_compare_smoke" / "comparison.json",
        {
            "profile_id": "asimov-1",
            "tasks": ["stand_up"],
            "steps": 64,
            "winner_by_mean_reward": "alberta",
            "alberta_vs_ppo_delta": {"mean_reward_overall": 1.0},
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_smoke" / "validation_report.json",
        {
            "ok": True,
            "deltas": {
                "alberta_acc_minus_ppo": 0.5,
                "alberta_forgetting_minus_ppo": -0.1,
            },
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_smoke" / "continual_benchmark.json",
        {
            "config": {
                "env_kind": "obstacle_course",
                "n_tasks": 4,
                "steps_per_task": 2500,
                "eval_episodes": 3,
                "seeds": 1,
            },
            "summary": {
                "alberta": {
                    "acc": {"mean": 2.0},
                    "bwt": {"mean": 0.0},
                    "forgetting": {"mean": 0.0},
                    "fwt": {"mean": 0.0},
                },
                "ppo": {
                    "acc": {"mean": 1.5},
                    "bwt": {"mean": -0.1},
                    "forgetting": {"mean": 0.1},
                    "fwt": {"mean": 0.2},
                },
            },
        },
    )
    _write_json(
        package / "evidence" / "alberta_obstacle_course_smoke" / "obstacle_course_demo.json",
        {"ok": True, "video": "demo.mp4", "video_bytes": 10, "frames": 2},
    )
    _write_json(
        package / "evidence" / "video_review" / "video_review.json",
        {
            "ok": True,
            "video_count": 2,
            "profiles": ["asimov-1", "unitree-g1"],
            "min_visual_progress": 0.2,
            "mean_visual_progress": 0.3,
            "videos": [{"frame_count": 40}, {"frame_count": 40}],
        },
    )
    _write_json(
        package / "evidence" / "agent_videos" / "manifest.json",
        {
            "ok": True,
            "profiles": [
                {
                    "profile": "asimov-1",
                    "videos": ["asimov-1_stand_up.mp4"],
                    "expected_videos": ["asimov-1_stand_up.mp4"],
                    "missing_videos": [],
                    "combined_present": True,
                    "ok": True,
                }
            ],
        },
    )

    report = generate_report(
        package_root=package,
        out_json=package / "evidence" / "report.json",
        out_md=package / "evidence" / "report.md",
    )

    assert report["ok"] is False
    assert report["video_review"]["manifest_review_consistent"] is False
    assert report["claim_support"]["evidence_consistent"] is False
    assert report["objective_requirements"]["robot_action_videos_self_reviewed"]["status"] == "partial"
    assert report["objective_requirements"]["detailed_report_generated"]["status"] == "partial"
