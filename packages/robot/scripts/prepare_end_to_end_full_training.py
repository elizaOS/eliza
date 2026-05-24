"""Prepare the end-to-end robot training launch bundle.

This creates a reviewable launch directory containing:

- an ASIMOV-1 Brax/MJX PPO baseline job package
- local preflight commands
- Nebius launch scripts for Alberta, backend comparison, continual benchmarks,
  Brax/MJX baseline, and post-training validation
- a JSON preflight report that validates the generated package contracts

The script does not run long training. It prepares and validates the artifacts
needed to start the full run without hand-assembling commands.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import stat
import sys
import time
from pathlib import Path
from typing import Any

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

load_curriculum = importlib.import_module("eliza_robot.curriculum.loader").load_curriculum
load_profile = importlib.import_module("eliza_robot.profiles.schema").load_profile
_write_full_training_job = importlib.import_module(
    "eliza_robot.rl.text_conditioned.train"
)._write_full_training_job
validate_full_training_job = importlib.import_module(
    "scripts.validate_asimov1_full_training_job"
).validate_full_training_job
validate_multi_robot = importlib.import_module(
    "scripts.validate_multi_robot_training_readiness"
).validate
validate_training_inputs = importlib.import_module(
    "scripts.validate_robot_training_inputs"
).build_report
validate_instance_launch_hygiene = importlib.import_module(
    "scripts.validate_nebius_instance_launch_hygiene"
).validate_instance_launch_hygiene

DEFAULT_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)
DEFAULT_PROFILES = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1", "unitree-r1")


def _write_executable(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(PKG_ROOT.resolve()))
    except ValueError:
        return str(path.resolve())


def _shell_header() -> str:
    return (
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"PACKAGE_ROOT=\"${{ELIZA_ROBOT_PACKAGE_ROOT:-{PKG_ROOT.resolve()}}}\"\n"
        "cd \"$PACKAGE_ROOT\"\n"
    )


def _make_scripts(
    out_dir: Path,
    *,
    profile_id: str,
    tasks: tuple[str, ...],
    alberta_steps: int,
    alberta_episode_steps: int,
    alberta_eval_episodes: int,
    backend_compare_steps: int,
    benchmark_steps_per_task: int,
    benchmark_seeds: int,
    brax_job_dir: Path,
) -> dict[str, str]:
    scripts_dir = out_dir / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    tasks_s = " ".join(tasks)
    scripts: dict[str, str] = {}

    local_preflight = scripts_dir / "00_local_preflight.sh"
    _write_executable(
        local_preflight,
        _shell_header()
        + f"uv run eliza-robot-validate-training-inputs --tasks {tasks_s} --out evidence/full_training_preflight/training_inputs_report.json\n"
        + f"uv run python scripts/validate_multi_robot_training_readiness.py --profiles {' '.join(DEFAULT_PROFILES)} --commands \"stand up\" \"walk forward\" \"turn left\" \"turn right\" --video-evidence evidence/agent_videos\n"
        + f"uv run python scripts/validate_asimov1_full_training_job.py --job-dir {_rel(brax_job_dir)}\n"
        + f"uv run python scripts/run_asimov1_full_training.py --job-dir {_rel(brax_job_dir)} --check-only --require-ready\n"
        + "uv run eliza-robot-validate-full-training-preflight evidence/full_training_preflight\n",
    )
    scripts["local_preflight"] = str(local_preflight)

    train_alberta = scripts_dir / "10_nebius_train_alberta.sh"
    _write_executable(
        train_alberta,
        _shell_header()
        + f"ALBERTA_STREAMING_STEPS=\"${{ALBERTA_STREAMING_STEPS:-{alberta_steps}}}\"\n"
        + "export JAX_PLATFORMS=cpu\n"
        + "export JAX_PLATFORM_NAME=cpu\n"
        + f"uv run eliza-robot-train --profile {profile_id} --tasks {tasks_s} --steps \"$ALBERTA_STREAMING_STEPS\" --episode-steps {alberta_episode_steps} --eval-episodes {alberta_eval_episodes} --out checkpoints/{profile_id.replace('-', '_')}_alberta_full --seed 0\n",
    )
    scripts["train_alberta"] = str(train_alberta)

    compare_backends = scripts_dir / "20_nebius_compare_backends.sh"
    _write_executable(
        compare_backends,
        _shell_header()
        + "export JAX_PLATFORMS=cpu\n"
        + "export JAX_PLATFORM_NAME=cpu\n"
        + f"uv run eliza-robot-compare-backends --profile {profile_id} --tasks {tasks_s} --steps {backend_compare_steps} --eval-episodes 5 --max-steps 200 --out-root evidence/backend_compare/{profile_id}\n"
        + f"uv run eliza-robot-validate-backend-comparison evidence/backend_compare/{profile_id} --expected-profile {profile_id} --min-steps {backend_compare_steps} --min-eval-mean-steps 20 > evidence/backend_compare/{profile_id}/validation_report.json\n",
    )
    scripts["compare_backends"] = str(compare_backends)

    continual = scripts_dir / "30_nebius_continual_benchmarks.sh"
    _write_executable(
        continual,
        _shell_header()
        + "export JAX_PLATFORMS=cpu\n"
        + "export JAX_PLATFORM_NAME=cpu\n"
        + f"uv run eliza-robot-benchmark-alberta --env joint_reach --steps-per-task {benchmark_steps_per_task} --seeds {benchmark_seeds} --out-dir evidence/alberta_joint_reach\n"
        + f"uv run eliza-robot-validate-alberta-benchmark evidence/alberta_joint_reach --expected-env joint_reach --min-steps-per-task {benchmark_steps_per_task} --min-seeds {benchmark_seeds} --min-tasks 4 --require-alberta-acc-gte-ppo --require-alberta-forgetting-lte-ppo > evidence/alberta_joint_reach/validation_report.json\n"
        + f"uv run eliza-robot-benchmark-alberta --env obstacle_course --steps-per-task {benchmark_steps_per_task} --seeds {benchmark_seeds} --out-dir evidence/alberta_obstacle_course\n"
        + "uv run eliza-robot-render-alberta-obstacle-demo evidence/alberta_obstacle_course\n"
        + f"uv run eliza-robot-validate-alberta-benchmark evidence/alberta_obstacle_course --expected-env obstacle_course --min-steps-per-task {benchmark_steps_per_task} --min-seeds {benchmark_seeds} --min-tasks 4 --require-alberta-forgetting-lte-ppo --require-demo-video > evidence/alberta_obstacle_course/validation_report.json\n"
    )
    scripts["continual_benchmarks"] = str(continual)

    brax = scripts_dir / "40_nebius_brax_baseline.sh"
    _write_executable(
        brax,
        _shell_header()
        + "unset CUDA_VISIBLE_DEVICES\n"
        + "unset JAX_PLATFORM_NAME\n"
        + "export JAX_PLATFORMS=\"${BRAX_JAX_PLATFORMS:-cuda,cpu}\"\n"
        + "if [[ \"${BRAX_REQUIRE_GPU:-1}\" == \"1\" ]]; then\n"
        + "  for attempt in $(seq 1 30); do\n"
        + "    if nvidia-smi -L >/dev/null 2>&1 && uv run python - <<'PY'\n"
        + "import jax\n"
        + "raise SystemExit(0 if jax.default_backend() == 'gpu' and jax.devices('gpu') else 1)\n"
        + "PY\n"
        + "    then\n"
        + "      break\n"
        + "    fi\n"
        + "    if [[ \"$attempt\" == \"30\" ]]; then\n"
        + "      echo \"Brax/MJX requested GPU, but CUDA was not ready after $attempt attempts\" >&2\n"
        + "      exit 70\n"
        + "    fi\n"
        + "    sleep 10\n"
        + "  done\n"
        + "fi\n"
        + f"{_rel(brax_job_dir)}/run_full_training.sh --train\n",
    )
    scripts["brax_baseline"] = str(brax)

    post = scripts_dir / "50_post_train_validation.sh"
    checkpoint = f"checkpoints/{profile_id.replace('-', '_')}_alberta_full"
    _write_executable(
        post,
        _shell_header()
        + f"ALBERTA_STREAMING_STEPS=\"${{ALBERTA_STREAMING_STEPS:-{alberta_steps}}}\"\n"
        + f"uv run eliza-robot-validate-alberta-checkpoint {checkpoint} --profile {profile_id} --tasks {tasks_s} --min-steps \"$ALBERTA_STREAMING_STEPS\" --require-domain-rand --require-inference\n"
        + f"uv run eliza-robot-validate-asimov1-production-checkpoint {checkpoint} --min-steps \"$ALBERTA_STREAMING_STEPS\" --require-inference-check\n"
        + f"uv run python scripts/validate_asimov1_real_agent_readiness.py --checkpoint {checkpoint} --production-min-steps \"$ALBERTA_STREAMING_STEPS\" --require-production --max-steps 2\n"
        + f"uv run python scripts/eval_text_policy.py --profile {profile_id} --ckpt {checkpoint} --tasks {tasks_s} --episodes 5 --max-steps 200\n"
        + f"uv run python scripts/evidence_text_to_action_e2e.py --checkpoint {checkpoint} --profile {profile_id} --no-real\n"
        + f"uv run python scripts/record_agent_videos.py --profiles {profile_id} --commands \"stand up\" \"walk forward\" \"turn left\" \"turn right\" --out evidence/agent_videos --max-steps 200 --policy-checkpoint {checkpoint}\n"
        + "uv run eliza-robot-review-video-evidence --evidence-dir evidence/agent_videos --out-dir evidence/video_review --require-telemetry\n"
        + f"uv run eliza-robot-generate-alberta-report --package-root . --scope production-nebius-post-training --backend-dir evidence/backend_compare/{profile_id} --backend-validation evidence/backend_compare/{profile_id}/validation_report.json --obstacle-dir evidence/alberta_obstacle_course --obstacle-validation evidence/alberta_obstacle_course/validation_report.json --video-review evidence/video_review/video_review.json --video-manifest evidence/agent_videos/manifest.json --out-json evidence/ALBERTA_END_TO_END_REPORT.json --out-md evidence/ALBERTA_END_TO_END_REPORT.md\n",
    )
    scripts["post_training_validation"] = str(post)

    runner = scripts_dir / "run_all_nebius_stages.sh"
    _write_executable(
        runner,
        _shell_header()
        + "uv run eliza-robot-run-full-training-bundle "
        + "--bundle-dir evidence/full_training_preflight "
        + '--endpoint "${NEBIUS_S3_ENDPOINT:-https://storage.eu-north1.nebius.cloud}" '
        + "--upload-uri \"${NEBIUS_TRAINING_S3_URI:-}\"\n",
    )
    scripts["run_all_stages"] = str(runner)
    return scripts


def _cloud_init_template() -> str:
    return """#cloud-config
users:
  - name: robot
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - "<ssh-public-key>"
write_files:
  - path: /root/robot-full/run.sh
    permissions: '0700'
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      mkdir -p /etc/robot-full
      while [ ! -f /etc/robot-full/object-storage.env ]; do
        echo "waiting for /etc/robot-full/object-storage.env $(date -u +%FT%TZ)"
        sleep 10
      done
      if [ -f /etc/robot-full/object-storage.env ]; then
        set -a
        . /etc/robot-full/object-storage.env
        set +a
      fi
      : "${NEBIUS_TRAINING_S3_URI:?set NEBIUS_TRAINING_S3_URI to s3://bucket/run-id}"
      export NEBIUS_S3_ENDPOINT="${NEBIUS_S3_ENDPOINT:-https://storage.eu-north1.nebius.cloud}"
      export ELIZA_ROBOT_PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/root/robot}"
      export MUJOCO_GL="${MUJOCO_GL:-egl}"
      export JAX_PLATFORMS="${JAX_PLATFORMS:-cuda,cpu}"
      export XLA_PYTHON_CLIENT_PREALLOCATE="${XLA_PYTHON_CLIENT_PREALLOCATE:-false}"
      export PATH="/root/.local/bin:/usr/local/cuda/bin:${PATH}"
      mkdir -p /root/robot-full/logs /root/robot-full/status
      if ! command -v aws >/dev/null 2>&1; then
        (curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip && cd /tmp && unzip -q awscli.zip && ./aws/install) || pip3 install awscli
      fi
      if ! command -v uv >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | sh
        export PATH="/root/.local/bin:${PATH}"
      fi
      aws --endpoint-url "${NEBIUS_S3_ENDPOINT}" s3 cp "${NEBIUS_TRAINING_S3_URI%/}/payload.tar.gz" /root/robot-full/payload.tar.gz --only-show-errors
      tar -xzf /root/robot-full/payload.tar.gz -C /root
      mkdir -p /root/eliza/packages /home/shaw/milady
      ln -sfn /root/robot /root/eliza/packages/robot
      ln -sfn /root/eliza /home/shaw/milady/eliza
      cd "${ELIZA_ROBOT_PACKAGE_ROOT}"
      chmod +x evidence/full_training_preflight/scripts/*.sh evidence/full_training_preflight/asimov_1_brax_mjx_baseline/run_full_training.sh || true
      uv sync --extra gpu || uv sync --all-extras || uv sync
      # The bundle runner uploads logs plus status/runner_status.json heartbeats.
      evidence/full_training_preflight/scripts/run_all_nebius_stages.sh
runcmd:
  - [ bash, -lc, "nohup /root/robot-full/run.sh > /root/robot-full/cloud-init-run.log 2>&1 &" ]
  - [ bash, -lc, "shutdown -h +720 'robot full training hard cost cap'" ]
"""


def _write_launch_template(out_dir: Path) -> dict[str, Any]:
    path = out_dir / "nebius_instance_launch_template.json"
    payload = {
        "metadata": {
            "id": "computeinstance-template",
            "name": "robot-full-training-template",
        },
        "spec": {
            "service_account_id": "<service-account-id>",
            "resources": {
                "platform": "gpu-h200-sxm",
                "preset": "1gpu-16vcpu-200gb",
            },
            "cloud_init_user_data": _cloud_init_template(),
        },
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return {
        "path": str(path),
        "hygiene": validate_instance_launch_hygiene(path),
    }


def prepare(
    *,
    out_dir: Path,
    profile_id: str,
    tasks: tuple[str, ...],
    alberta_steps: int,
    alberta_episode_steps: int,
    alberta_eval_episodes: int,
    backend_compare_steps: int,
    brax_steps: int,
    brax_num_envs: int,
    brax_num_evals: int,
    benchmark_steps_per_task: int,
    benchmark_seeds: int,
    run_multi_readiness: bool,
) -> dict[str, Any]:
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    profile = load_profile(profile_id)
    curriculum = load_curriculum()
    brax_job_dir = out_dir / "asimov_1_brax_mjx_baseline"
    _write_full_training_job(
        brax_job_dir,
        "asimov-1",
        total_steps=brax_steps,
        num_envs=brax_num_envs,
        num_evals=brax_num_evals,
        seed=0,
        learning_rate=3e-4,
        domain_rand=True,
    )
    brax_validation = validate_full_training_job(brax_job_dir)
    multi_validation = None
    if run_multi_readiness:
        multi_validation = validate_multi_robot(
            profiles=list(DEFAULT_PROFILES),
            commands=["stand up", "walk forward", "turn left", "turn right"],
            video_evidence=PKG_ROOT / "evidence" / "agent_videos",
            pca_dim=32,
            min_video_bytes=1024,
            require_combined_videos=True,
        )
    training_inputs = validate_training_inputs(launch_tasks=tasks)

    scripts = _make_scripts(
        out_dir,
        profile_id=profile_id,
        tasks=tasks,
        alberta_steps=alberta_steps,
        alberta_episode_steps=alberta_episode_steps,
        alberta_eval_episodes=alberta_eval_episodes,
        backend_compare_steps=backend_compare_steps,
        benchmark_steps_per_task=benchmark_steps_per_task,
        benchmark_seeds=benchmark_seeds,
        brax_job_dir=brax_job_dir,
    )
    launch_template = _write_launch_template(out_dir)

    checks = {
        "profile_loads": profile.id == profile_id,
        "tasks_declared": set(tasks).issubset({task.id for task in curriculum.tasks}),
        "training_inputs_valid": bool(training_inputs["ok"]),
        "brax_job_valid": bool(brax_validation["ok"]),
        "multi_robot_readiness": True if multi_validation is None else bool(multi_validation["ok"]),
        "scripts_executable": all(os.access(path, os.X_OK) for path in scripts.values()),
        "launch_template_hygiene": bool(launch_template["hygiene"]["ok"]),
    }
    report = {
        "schema": "robot-end-to-end-full-training-preflight-v1",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ok": all(checks.values()),
        "package_root": str(PKG_ROOT.resolve()),
        "out_dir": str(out_dir.resolve()),
        "profile_id": profile_id,
        "default_profiles": list(DEFAULT_PROFILES),
        "tasks": list(tasks),
        "budgets": {
            "alberta_steps": int(alberta_steps),
            "alberta_episode_steps": int(alberta_episode_steps),
            "alberta_eval_episodes": int(alberta_eval_episodes),
            "backend_compare_steps": int(backend_compare_steps),
            "brax_steps": int(brax_steps),
            "brax_num_envs": int(brax_num_envs),
            "brax_num_evals": int(brax_num_evals),
            "benchmark_steps_per_task": int(benchmark_steps_per_task),
            "benchmark_seeds": int(benchmark_seeds),
        },
        "checks": checks,
        "scripts": scripts,
        "launch_template": launch_template,
        "brax_job_dir": str(brax_job_dir),
        "brax_validation": {
            "ok": brax_validation["ok"],
            "failed_checks": [
                name for name, ok in brax_validation["checks"].items() if not ok
            ],
        },
        "training_inputs": {
            "ok": training_inputs["ok"],
            "curriculum": training_inputs["curriculum"],
            "rl_from_sim_ready": training_inputs["datasets"]["rl_from_sim_ready"],
            "imitation_training_ready": training_inputs["datasets"]["imitation_training_ready"],
            "offline_datasets_block_current_plan": training_inputs["datasets"][
                "offline_datasets_block_current_plan"
            ],
            "dataset_warning_count": len(
                [
                    warning
                    for warning in training_inputs["warnings"]
                    if warning["kind"] == "no_offline_policy_datasets"
                ]
            ),
            "unsupported_future_task_count": len(
                next(
                    (
                        warning["tasks"]
                        for warning in training_inputs["warnings"]
                        if warning["kind"] == "unsupported_future_curriculum_tasks"
                    ),
                    [],
                )
            ),
        },
        "multi_robot_readiness": (
            None
            if multi_validation is None
            else {
                "ok": multi_validation["ok"],
                "alberta_ok": multi_validation["alberta"]["ok"],
                "video_ok": multi_validation["video_evidence"]["ok"],
            }
        ),
        "launch_order": [
            "scripts/00_local_preflight.sh",
            "scripts/10_nebius_train_alberta.sh",
            "scripts/20_nebius_compare_backends.sh",
            "scripts/30_nebius_continual_benchmarks.sh",
            "scripts/40_nebius_brax_baseline.sh",
            "scripts/50_post_train_validation.sh",
        ],
    }
    (out_dir / "preflight_report.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / "README.md").write_text(
        "# End-to-End Full Training Launch Bundle\n\n"
        "Run `scripts/00_local_preflight.sh` before copying this repo to Nebius. "
        "Scripts run from `ELIZA_ROBOT_PACKAGE_ROOT` when it is set, otherwise "
        "from the package root that generated this bundle. On the Nebius host, "
        "run `scripts/run_all_nebius_stages.sh`. "
        "The generated `preflight_report.json` must have `ok: true` before launch. "
        "`nebius_instance_launch_template.json` is the reviewable cloud-init "
        "contract; inject Object Storage credentials outside VM metadata and set "
        "`NEBIUS_TRAINING_S3_URI` through the runtime secret environment.\n",
        encoding="utf-8",
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=PKG_ROOT / "evidence" / "full_training_preflight")
    parser.add_argument("--profile", default="asimov-1")
    parser.add_argument("--tasks", nargs="+", default=list(DEFAULT_TASKS))
    parser.add_argument("--alberta-steps", type=int, default=150_000_000)
    parser.add_argument("--alberta-episode-steps", type=int, default=200)
    parser.add_argument("--alberta-eval-episodes", type=int, default=3)
    parser.add_argument("--backend-compare-steps", type=int, default=30_000)
    parser.add_argument("--brax-steps", type=int, default=150_000_000)
    parser.add_argument("--brax-num-envs", type=int, default=8192)
    parser.add_argument("--brax-num-evals", type=int, default=10)
    parser.add_argument("--benchmark-steps-per-task", type=int, default=16_000)
    parser.add_argument("--benchmark-seeds", type=int, default=3)
    parser.add_argument(
        "--skip-multi-readiness",
        action="store_true",
        help="Skip the local multi-robot readiness validator when only generating scripts.",
    )
    args = parser.parse_args(argv)
    report = prepare(
        out_dir=args.out_dir,
        profile_id=args.profile,
        tasks=tuple(args.tasks),
        alberta_steps=args.alberta_steps,
        alberta_episode_steps=args.alberta_episode_steps,
        alberta_eval_episodes=args.alberta_eval_episodes,
        backend_compare_steps=args.backend_compare_steps,
        brax_steps=args.brax_steps,
        brax_num_envs=args.brax_num_envs,
        brax_num_evals=args.brax_num_evals,
        benchmark_steps_per_task=args.benchmark_steps_per_task,
        benchmark_seeds=args.benchmark_seeds,
        run_multi_readiness=not args.skip_multi_readiness,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
