from __future__ import annotations

import json
import os
from pathlib import Path

from scripts import prepare_end_to_end_full_training as preflight


def test_prepare_end_to_end_full_training_bundle(tmp_path: Path) -> None:
    report = preflight.prepare(
        out_dir=tmp_path,
        profile_id="asimov-1",
        tasks=(
            "stand_up",
            "walk_forward",
            "walk_backward",
            "sidestep_left",
            "sidestep_right",
            "turn_left",
            "turn_right",
        ),
        alberta_steps=100,
        alberta_episode_steps=11,
        alberta_eval_episodes=2,
        backend_compare_steps=20,
        brax_steps=100,
        brax_num_envs=16,
        brax_num_evals=1,
        benchmark_steps_per_task=8,
        benchmark_seeds=1,
        run_multi_readiness=False,
    )

    assert report["ok"] is True
    assert report["checks"]["brax_job_valid"] is True
    assert report["checks"]["scripts_executable"] is True
    assert report["budgets"]["alberta_steps"] == 100
    assert report["budgets"]["alberta_episode_steps"] == 11
    assert report["budgets"]["alberta_eval_episodes"] == 2
    assert report["budgets"]["brax_steps"] == 100
    assert (tmp_path / "preflight_report.json").is_file()
    assert (tmp_path / "asimov_1_brax_mjx_baseline" / "training_job.json").is_file()
    assert (tmp_path / "asimov_1_brax_mjx_baseline" / "run_full_training.sh").is_file()

    loaded = json.loads((tmp_path / "preflight_report.json").read_text())
    assert loaded["schema"] == "robot-end-to-end-full-training-preflight-v1"
    assert loaded["training_inputs"]["rl_from_sim_ready"] is True
    assert loaded["training_inputs"]["imitation_training_ready"] is False
    assert loaded["training_inputs"]["offline_datasets_block_current_plan"] is False
    assert loaded["checks"]["launch_template_hygiene"] is True
    assert loaded["launch_template"]["hygiene"]["ok"] is True
    assert (
        loaded["launch_template"]["hygiene"]["checks"][
            "uses_repo_owned_stage_runner"
        ]
        is True
    )
    launch_template = Path(loaded["launch_template"]["path"])
    assert launch_template.is_file()
    launch_text = launch_template.read_text()
    assert "NEBIUS_TRAINING_S3_URI" in launch_text
    assert "run_all_nebius_stages.sh" in launch_text
    assert "runner_status.json" in launch_text
    launch_payload = json.loads(launch_text)
    cloud_init = launch_payload["spec"]["cloud_init_user_data"]
    assert 'ELIZA_ROBOT_PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/root/robot}"' in cloud_init
    assert "ln -sfn /root/robot /root/eliza/packages/robot" in cloud_init
    assert "AWS_ACCESS_KEY_ID" not in launch_text
    assert "AWS_SECRET_ACCESS_KEY" not in launch_text
    assert loaded["default_profiles"] == [
        "hiwonder-ainex",
        "asimov-1",
        "unitree-g1",
        "unitree-h1",
        "unitree-r1",
    ]
    assert loaded["checks"]["video_commands_cover_production"] is True
    assert loaded["video_commands"] == [
        "stand up",
        "walk forward",
        "walk backward",
        "sidestep left",
        "sidestep right",
        "turn left",
        "turn right",
    ]
    for script in loaded["scripts"].values():
        assert os.access(script, os.X_OK)

    train_script = (tmp_path / "scripts" / "10_nebius_train_alberta.sh").read_text()
    assert "ELIZA_ROBOT_PACKAGE_ROOT" in train_script
    assert "ALBERTA_STREAMING_STEPS" in train_script
    assert "export JAX_PLATFORMS=cpu" in train_script
    assert "export JAX_PLATFORM_NAME=cpu" in train_script
    assert "uv run eliza-robot-train" in train_script
    assert '--steps "$ALBERTA_STREAMING_STEPS"' in train_script
    assert "--episode-steps 11" in train_script
    assert "--eval-episodes 2" in train_script
    assert "--require-phase-success" in train_script
    assert "--min-phase-success-rate 1.0" in train_script

    local_preflight_script = (tmp_path / "scripts" / "00_local_preflight.sh").read_text()
    assert "--profiles hiwonder-ainex asimov-1 unitree-g1 unitree-h1 unitree-r1" in local_preflight_script
    assert '--commands "stand up" "walk forward" "walk backward" "sidestep left" "sidestep right" "turn left" "turn right"' in local_preflight_script
    assert "--video-evidence evidence/multi_robot_smoke_videos" in local_preflight_script
    assert (
        "eliza-robot-validate-full-training-preflight evidence/full_training_preflight"
        in local_preflight_script
    )

    runner_script = (tmp_path / "scripts" / "run_all_nebius_stages.sh").read_text()
    assert "uv run eliza-robot-run-full-training-bundle" in runner_script
    assert "--bundle-dir evidence/full_training_preflight" in runner_script
    assert "NEBIUS_S3_ENDPOINT" in runner_script
    assert "NEBIUS_TRAINING_S3_URI" in runner_script

    compare_script = (tmp_path / "scripts" / "20_nebius_compare_backends.sh").read_text()
    assert "export JAX_PLATFORMS=cpu" in compare_script
    assert "export JAX_PLATFORM_NAME=cpu" in compare_script
    assert "uv run eliza-robot-compare-backends" in compare_script
    assert "--steps 20" in compare_script
    assert "--min-eval-mean-steps 20" in compare_script
    assert "> evidence/backend_compare/asimov-1/validation_report.json" in compare_script

    continual_script = (tmp_path / "scripts" / "30_nebius_continual_benchmarks.sh").read_text()
    assert "export JAX_PLATFORMS=cpu" in continual_script
    assert "export JAX_PLATFORM_NAME=cpu" in continual_script
    assert "uv run eliza-robot-benchmark-alberta" in continual_script
    assert "uv run eliza-robot-validate-alberta-benchmark" in continual_script
    assert "--env joint_reach" in continual_script
    assert "--expected-env joint_reach" in continual_script
    assert "--env obstacle_course" in continual_script
    assert "--expected-env obstacle_course" in continual_script
    assert continual_script.count("--min-tasks 4") == 2
    assert continual_script.count("--require-alberta-acc-gte-ppo") == 1
    assert continual_script.count("--require-alberta-forgetting-lte-ppo") == 2
    assert "> evidence/alberta_joint_reach/validation_report.json" in continual_script
    assert "> evidence/alberta_obstacle_course/validation_report.json" in continual_script
    assert "eliza-robot-render-alberta-obstacle-demo evidence/alberta_obstacle_course" in continual_script
    assert "--require-demo-video" in continual_script

    brax_script = (tmp_path / "scripts" / "40_nebius_brax_baseline.sh").read_text()
    assert "unset CUDA_VISIBLE_DEVICES" in brax_script
    assert "unset JAX_PLATFORM_NAME" in brax_script
    assert 'BRAX_JAX_PLATFORMS:-cuda,cpu' in brax_script
    assert "BRAX_REQUIRE_GPU" in brax_script
    assert "nvidia-smi -L" in brax_script
    assert "jax.default_backend() == 'gpu'" in brax_script
    assert "run_full_training.sh --train" in brax_script

    full_training_script = (
        tmp_path / "asimov_1_brax_mjx_baseline" / "run_full_training.sh"
    ).read_text()
    assert 'BRAX_MJX_STEPS="${BRAX_MJX_STEPS:-100}"' in full_training_script
    assert "training_job.full_contract.json" in full_training_script
    assert '--min-steps "$BRAX_MJX_STEPS"' in full_training_script

    post_script = (tmp_path / "scripts" / "50_post_train_validation.sh").read_text()
    assert "ALBERTA_STREAMING_STEPS" in post_script
    assert "POST_TRAIN_EVAL_EPISODES" in post_script
    assert "POST_TRAIN_EVAL_MAX_STEPS" in post_script
    assert "POST_TRAIN_VIDEO_MAX_STEPS" in post_script
    assert "POST_TRAIN_SKIP_EVAL" in post_script
    assert "export JAX_PLATFORMS=cpu" in post_script
    assert "export JAX_PLATFORM_NAME=cpu" in post_script
    assert "unset CUDA_VISIBLE_DEVICES" in post_script
    assert "uv run eliza-robot-validate-alberta-checkpoint" in post_script
    assert (
        "--tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right"
        in post_script
    )
    assert '--min-steps "$ALBERTA_STREAMING_STEPS"' in post_script
    assert "--require-domain-rand" in post_script
    assert "--require-inference" in post_script
    assert "uv run eliza-robot-validate-asimov1-production-checkpoint" in post_script
    assert "--require-inference-check" in post_script
    assert "validate_asimov1_real_agent_readiness.py" in post_script
    assert "--require-production" in post_script
    assert "evidence_text_to_action_e2e.py --checkpoint" in post_script
    assert "--profile asimov-1 --no-real" in post_script
    assert "--out evidence/curriculum_eval/eval_text_policy.json" in post_script
    assert "--curriculum-report-out evidence/curriculum_eval/report.json" in post_script
    assert '--episodes "$POST_TRAIN_EVAL_EPISODES"' in post_script
    assert '--max-steps "$POST_TRAIN_EVAL_MAX_STEPS"' in post_script
    assert 'if [[ "$POST_TRAIN_SKIP_EVAL" != "1" ]]' in post_script
    assert "record_agent_videos.py --profiles hiwonder-ainex asimov-1 unitree-g1 unitree-h1 unitree-r1" in post_script
    assert "--out evidence/multi_robot_smoke_videos" in post_script
    assert "--scripted-smoke" in post_script
    assert "eliza-robot-review-video-evidence --evidence-dir evidence/multi_robot_smoke_videos --out-dir evidence/multi_robot_smoke_review" in post_script
    assert "record_agent_videos.py --profiles asimov-1" in post_script
    assert '--commands "stand up" "walk forward" "walk backward" "sidestep left" "sidestep right" "turn left" "turn right"' in post_script
    assert "rm -rf evidence/multi_robot_smoke_videos evidence/agent_videos evidence/video_review" in post_script
    assert '--max-steps "$POST_TRAIN_VIDEO_MAX_STEPS"' in post_script
    assert "--policy-checkpoint checkpoints/asimov_1_alberta_full" in post_script
    assert "eliza-robot-generate-alberta-report" in post_script
    assert "--scope production-nebius-post-training" in post_script
    assert "--backend-dir evidence/backend_compare/asimov-1" in post_script
    assert "--obstacle-dir evidence/alberta_obstacle_course" in post_script
