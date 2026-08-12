"""Guards the isolated Python dependency stacks and secure lock floors.

The metadata tests read the real project and generated uv lock. The launcher
test executes the shell entry point with a controlled missing-runtime probe.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tomllib
from copy import deepcopy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _read_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _release(version: str) -> tuple[int, ...]:
    match = re.match(r"\d+(?:\.\d+)*", version)
    assert match is not None, f"expected a release version, got {version!r}"
    return tuple(int(component) for component in match.group(0).split("."))


def _locked_versions(lock: dict, name: str) -> list[str]:
    return [
        package["version"] for package in lock["package"] if package["name"] == name
    ]


def _locked_packages(lock: dict, name: str) -> list[dict]:
    return [package for package in lock["package"] if package["name"] == name]


def _conflict_pairs(project: dict) -> set[frozenset[str]]:
    return {
        frozenset(item["extra"] for item in conflict)
        for conflict in project["tool"]["uv"]["conflicts"]
    }


def test_optional_stacks_encode_supported_secure_resolutions() -> None:
    project = _read_toml(ROOT / "pyproject.toml")
    metadata = project["project"]
    extras = metadata["optional-dependencies"]

    assert metadata["requires-python"] == ">=3.11,<3.12"
    assert "setuptools>=83.0.0" in metadata["dependencies"]
    assert "huggingface-hub>=1.14.0" in metadata["dependencies"]
    assert "translate" not in extras
    assert not any(
        requirement.startswith(("argostranslate", "stanza"))
        for requirements in [metadata["dependencies"], *extras.values()]
        for requirement in requirements
    )
    assert "torch>=2.13.0,<2.14.0" in extras["train"]
    assert "verl[vllm]" in extras["rl"]
    assert "vllm>=0.27.1,<0.28.0" in extras["rl"]
    assert "ray[default]>=2.56.0,<3.0.0" in extras["rl"]
    assert "litellm>=1.84.0,<2.0.0" in extras["rl"]
    assert "vllm>=0.27.1,<0.28.0" in extras["serve"]
    assert not any(
        "sglang" in requirement.lower()
        for requirements in extras.values()
        for requirement in requirements
    )

    verl_source = project["tool"]["uv"]["sources"]["verl"]
    assert verl_source["git"] == "https://github.com/verl-project/verl.git"
    assert re.fullmatch(r"[0-9a-f]{40}", verl_source["rev"])
    assert verl_source["rev"] == "668baad7455453eac8ab863f1b2d6fecaec746ed"

    pairs = _conflict_pairs(project)
    assert frozenset(("train", "rl")) in pairs
    assert frozenset(("serve", "rl")) in pairs
    assert frozenset(("train", "serve")) in pairs
    assert not any("translate" in pair for pair in pairs)


def test_supported_lock_entries_keep_security_floors_and_rollout_source() -> None:
    lock = _read_toml(ROOT / "uv.lock")

    assert lock["requires-python"] == "==3.11.*"
    for name, floor in {
        "litellm": (1, 84, 0),
        "ray": (2, 56, 0),
        "setuptools": (83, 0, 0),
        "vllm": (0, 27, 1),
    }.items():
        versions = _locked_versions(lock, name)
        assert versions, f"{name} must remain represented in uv.lock"
        assert all(_release(version) >= floor for version in versions), versions

    assert _locked_versions(lock, "sglang") == []
    assert _locked_versions(lock, "argostranslate") == []
    assert _locked_versions(lock, "stanza") == []
    assert _locked_versions(lock, "torch") == ["2.13.0"]
    verl_packages = _locked_packages(lock, "verl")
    assert len(verl_packages) == 1
    assert verl_packages[0]["source"] == {
        "git": (
            "https://github.com/verl-project/verl.git"
            "?rev=668baad7455453eac8ab863f1b2d6fecaec746ed"
            "#668baad7455453eac8ab863f1b2d6fecaec746ed"
        )
    }
    hub_versions = _locked_versions(lock, "huggingface-hub")
    assert hub_versions
    assert all(_release(version) >= (1, 14, 0) for version in hub_versions)


def test_launchers_enforce_deliberate_stage_isolation() -> None:
    grpo = (ROOT / "scripts" / "train_grpo_verl.sh").read_text()
    smoke = (ROOT / "scripts" / "smoke_full_stack.sh").read_text()

    assert '"actor_rollout_ref.rollout.name=vllm"' in grpo
    assert "sglang" not in grpo
    assert "pip install 'verl" not in grpo
    assert "uv run --locked --extra rl" in grpo
    assert grpo.index("import ray, verl, vllm") < grpo.index('mkdir -p "$OUTPUT_DIR"')
    assert grpo.index("--cfg job --resolve") < grpo.index('mkdir -p "$OUTPUT_DIR"')
    assert grpo.index("validate_grpo_verl_config.py") < grpo.index(
        'mkdir -p "$OUTPUT_DIR"'
    )
    assert '"critic.enable=False"' in grpo
    assert '"reward.reward_model.enable=False"' in grpo
    assert '"reward.custom_reward_function.path=$REWARD_FUNCTION_PATH"' in grpo

    assert '.venv-smoke-train" uv run --locked --extra train' in smoke
    assert '.venv-smoke-serve" uv run --locked --extra serve' in smoke
    assert "--extra train --extra serve" not in smoke


def test_smoke_stage_environments_are_ignored_and_never_synced() -> None:
    ignore = (ROOT / ".gitignore").read_text()
    vast = (ROOT / "scripts" / "train_vast.sh").read_text()
    nebius = (ROOT / "scripts" / "train_nebius.sh").read_text()

    for environment in (".venv-smoke-train/", ".venv-smoke-serve/"):
        assert environment in ignore
        assert f"--exclude '{environment}'" in vast
        assert f"--exclude '{environment}'" in nebius


def test_grpo_config_contract_rejects_missing_pinned_verl_defaults() -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        from validate_grpo_verl_config import validate_contract
    finally:
        sys.path.pop(0)

    dataset = Path("/tmp/eliza-grpo/verl_train.jsonl")
    checkpoint = Path("/tmp/eliza-grpo/checkpoint")
    reward_function = ROOT / "scripts" / "eliza_reward_fn.py"
    config = {
        "algorithm": {"adv_estimator": "grpo", "use_kl_in_reward": False},
        "data": {
            "train_files": [str(dataset)],
            "val_files": [str(dataset)],
            "prompt_key": "prompt",
            "train_batch_size": 2,
        },
        "actor_rollout_ref": {
            "model": {"path": str(checkpoint)},
            "actor": {"use_kl_loss": True, "kl_loss_coef": 0.001},
            "rollout": {"name": "vllm", "n": 2},
        },
        "critic": {"enable": False},
        "reward": {
            "reward_model": {"enable": False},
            "custom_reward_function": {
                "path": str(reward_function),
                "name": "compute_score",
            },
        },
        "trainer": {
            "total_epochs": 1,
            "n_gpus_per_node": 2,
            "nnodes": 1,
            "use_v1": True,
        },
        "ray_kwargs": {},
        "transfer_queue": {},
        "global_profiler": {},
    }
    kwargs = {
        "dataset": dataset,
        "checkpoint": checkpoint,
        "reward_function": reward_function,
        "rollouts": 2,
        "rollout_batch": 2,
        "epochs": 1,
        "kl_coef": 0.001,
        "gpus": 2,
    }
    validate_contract(config, **kwargs)

    incomplete = deepcopy(config)
    del incomplete["transfer_queue"]
    with pytest.raises(ValueError, match="transfer_queue"):
        validate_contract(incomplete, **kwargs)


def test_grpo_dataset_adapter_separates_prompt_and_ground_truth() -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        from prepare_grpo_verl_dataset import convert_record
    finally:
        sys.path.pop(0)

    converted = convert_record(
        {
            "messages": [
                {"role": "system", "content": "Be concise."},
                {"role": "user", "content": "Say hello."},
                {"role": "assistant", "content": "Hello."},
            ]
        }
    )

    assert converted["prompt"][-1] == {"role": "user", "content": "Say hello."}
    assert all(message["role"] != "assistant" for message in converted["prompt"])
    assert converted["reward_model"]["ground_truth"] == {"expected": "Hello."}
    assert converted["extra_info"]["prompt"] == "Say hello."


def test_grpo_dataset_adapter_preserves_native_tool_context() -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        from prepare_grpo_verl_dataset import convert_record
    finally:
        sys.path.pop(0)

    converted = convert_record(
        {
            "messages": [
                {"role": "user", "content": "Check the weather."},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_0",
                            "type": "function",
                            "function": {
                                "name": "weather",
                                "arguments": '{"city":"LA"}',
                            },
                        }
                    ],
                },
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "weather",
                        "description": "Read weather",
                        "parameters": {"type": "object"},
                    },
                }
            ],
        }
    )

    assert converted["prompt"][0]["role"] == "system"
    assert "Available tools (JSON)" in converted["prompt"][0]["content"]
    assert '"weather"' in converted["prompt"][0]["content"]
    assert (
        converted["reward_model"]["ground_truth"]["expectedToolCalls"][0]["function"][
            "name"
        ]
        == "weather"
    )


def test_grpo_launcher_fails_before_artifacts_without_locked_runtime(
    tmp_path: Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_python = fake_bin / "python3"
    fake_python.write_text("#!/bin/sh\nexit 42\n")
    fake_python.chmod(0o755)

    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    train_file = tmp_path / "train.jsonl"
    train_file.write_text('{"prompt": "smoke"}\n')
    output_dir = tmp_path / "output"
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"

    result = subprocess.run(
        [
            "bash",
            str(ROOT / "scripts" / "train_grpo_verl.sh"),
            "--registry-key",
            "gemma4-e2b",
            "--dpo-checkpoint",
            str(checkpoint),
            "--output-dir",
            str(output_dir),
            "--train-file",
            str(train_file),
            "--gpus",
            "1",
        ],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 1
    assert "locked verl/vLLM RL runtime is not active" in result.stderr
    assert "uv run --locked --extra rl" in result.stderr
    assert not output_dir.exists()


def test_translation_launcher_is_unsupported_and_writes_nothing(tmp_path: Path) -> None:
    result = subprocess.run(
        ["python3", str(ROOT / "scripts" / "translate_corpus.py")],
        cwd=tmp_path,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2
    assert "Offline corpus translation is currently unsupported" in result.stderr
    assert "data/synthesized/translated/" in result.stderr
    assert list(tmp_path.iterdir()) == []
