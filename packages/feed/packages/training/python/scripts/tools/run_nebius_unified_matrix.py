#!/usr/bin/env python3
"""
Provision a Nebius GPU VM and run the unified ScamBench matrix remotely.

This script avoids local laptop training by:
1. Creating a GPU VM on Nebius.
2. Uploading the minimum workspace subset needed for training/eval.
3. Running baseline, LoRA, and APOLLO experiments remotely.
4. Downloading score files, manifests, and logs back to the local workspace.

It is intentionally opinionated around the current unified scam-defense setup.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import textwrap
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PYTHON_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON_ROOT / "src" / "training"))

from qwen_capacity import (
    NEBIUS_VM_SHAPES,
    QwenModelSpec,
    recommend_nebius_vm_shape,
    resolve_model_spec,
    slugify_model_name,
)

WORKSPACE_ROOT = Path(
    os.environ.get("BABYLON_WORKSPACE_ROOT", str(Path(__file__).resolve().parents[6]))
)


def resolve_scambench_root(workspace_root: Path) -> Path:
    candidates = [
        workspace_root / "scambench",
        workspace_root / "benchmarks" / "scambench",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


SCAMBENCH_ROOT = resolve_scambench_root(WORKSPACE_ROOT)
DEFAULT_WEIGHTED_EXPORT = (
    WORKSPACE_ROOT
    / "babylon"
    / "training-data"
    / "scam-defense-export"
    / "2026-03-27T-unified-weighted-format"
)
DEFAULT_UNWEIGHTED_EXPORT = (
    WORKSPACE_ROOT
    / "babylon"
    / "training-data"
    / "scam-defense-export"
    / "2026-03-27T-unified-unweighted"
)
DEFAULT_SCENARIO_CATALOG = SCAMBENCH_ROOT / "generated" / "scenario-catalog.json"
DEFAULT_RESULTS_ROOT = WORKSPACE_ROOT / "babylon" / "runs" / "nebius-unified"
STAGED_INPUTS_ROOT = Path("babylon") / "runs" / "nebius-unified" / "_inputs"


@dataclass(frozen=True)
class MatrixVariantSpec:
    variant_id: str
    kind: str
    source_key: str | None = None
    optimizer: str | None = None
    lora: bool | None = None
    learning_rate_attr: str | None = None


MATRIX_VARIANT_SPECS = (
    MatrixVariantSpec("baseline", "baseline"),
    MatrixVariantSpec(
        "lora-unweighted",
        "lora",
        source_key="unweighted",
        optimizer="adamw",
        lora=True,
        learning_rate_attr="lora_learning_rate",
    ),
    MatrixVariantSpec(
        "lora-weighted",
        "lora",
        source_key="weighted",
        optimizer="adamw",
        lora=True,
        learning_rate_attr="lora_learning_rate",
    ),
    MatrixVariantSpec(
        "apollo-unweighted",
        "apollo",
        source_key="unweighted",
        optimizer="apollo",
        lora=False,
        learning_rate_attr="apollo_learning_rate",
    ),
    MatrixVariantSpec(
        "apollo-weighted",
        "apollo",
        source_key="weighted",
        optimizer="apollo",
        lora=False,
        learning_rate_attr="apollo_learning_rate",
    ),
)
DEFAULT_VARIANTS = [spec.variant_id for spec in MATRIX_VARIANT_SPECS]
RSYNC_EXCLUDES = [
    "__pycache__/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    ".venv/",
    "venv/",
    "*.pyc",
    "*.pyo",
    ".DS_Store",
    "logs/",
    "rollout_dumps/",
    "node_modules/",
]
MODEL_DOWNLOAD_PATTERNS = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "tokenizer.model",
    "special_tokens_map.json",
    "chat_template.jinja",
    "model.safetensors",
    "model.safetensors.index.json",
    "model-*.safetensors",
    "training_manifest.json",
    "training_metrics.json",
    "validation_report.json",
]
PUBLIC_IPV4_QUOTA_KEY = "vpc.ipv4-address.public.count"


def run_command(
    command: list[str],
    *,
    cwd: Path | None = None,
    capture: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=check,
        text=True,
        capture_output=capture,
    )


def run_json(command: list[str], *, cwd: Path | None = None) -> dict[str, Any]:
    completed = run_command(command, cwd=cwd)
    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError(f"Command returned no JSON output: {' '.join(command)}")
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Command did not return valid JSON: {' '.join(command)}\n{stdout}"
        ) from exc


def quota_error_message(stderr: str) -> str | None:
    quota_match = re.search(
        r"(?P<quota>[\w.\-]+) \(limit (?P<limit>\d+), requested (?P<requested>\d+)\)",
        stderr,
    )
    if quota_match is None:
        return None
    quota_name = quota_match.group("quota")
    limit = quota_match.group("limit")
    requested = quota_match.group("requested")
    if quota_name == PUBLIC_IPV4_QUOTA_KEY:
        return (
            "Nebius public IPv4 quota is exhausted "
            f"(quota {quota_name}, limit {limit}, requested {requested}). "
            "Free a public IP or rerun this command with --existing-host and --existing-user "
            "to reuse a running VM."
        )
    return (
        "Nebius quota is exhausted "
        f"(quota {quota_name}, limit {limit}, requested {requested}). "
        "Free capacity or adjust the requested VM shape before retrying."
    )


def model_slug(base_model: str) -> str:
    return slugify_model_name(base_model)


def remote_workspace_path(workspace: str, path: Path) -> str:
    return f"{workspace}/{bundle_relative_path(path)}"


def variant_label(model_name_slug: str, variant_id: str) -> str:
    return f"{variant_id}-{model_name_slug}-unified-nebius"


def variant_training_label(model_name_slug: str, variant_id: str) -> str:
    return f"scam-defense-{model_name_slug}-unified-nebius-{variant_id}"


def variant_training_output_dir(workspace: str, model_name_slug: str, variant_id: str) -> str:
    return (
        f"{workspace}/babylon/trained_models/{variant_training_label(model_name_slug, variant_id)}"
    )


def score_output_path(decisions_output_path: str) -> str:
    if not decisions_output_path.endswith(".json"):
        raise ValueError(f"Expected a JSON decisions path, got: {decisions_output_path}")
    return f"{decisions_output_path[:-5]}-score.json"


def nebius_config_value(key: str) -> str:
    completed = run_command(["nebius", "config", "get", key])
    return completed.stdout.strip()


def ensure_nebius_auth() -> None:
    completed = run_command(
        ["nebius", "iam", "get-access-token", "--format", "json"],
        check=False,
    )
    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    combined = "\n".join(part for part in [stdout, stderr] if part)
    if completed.returncode != 0 or "Switch to your browser" in combined:
        raise RuntimeError(
            "Nebius CLI is not authenticated. Complete `nebius iam get-access-token` "
            "in a browser, then rerun this script."
        )


def build_cloud_init_user_data(username: str, public_key: str) -> str:
    return textwrap.dedent(
        f"""\
        users:
          - name: {username}
            sudo: ALL=(ALL) NOPASSWD:ALL
            shell: /bin/bash
            ssh_authorized_keys:
              - {public_key.strip()}
        package_update: true
        packages:
          - git
          - rsync
          - tmux
          - build-essential
          - python3-venv
          - python3-pip
        """
    )


def create_boot_disk(
    *,
    project_id: str,
    name: str,
    size_gib: int,
    image_family: str,
) -> str:
    payload = run_json(
        [
            "nebius",
            "compute",
            "disk",
            "create",
            "--format",
            "json",
            "--name",
            name,
            "--size-gibibytes",
            str(size_gib),
            "--type",
            "network_ssd",
            "--block-size-bytes",
            "4096",
            "--source-image-family-image-family",
            image_family,
            "--parent-id",
            project_id,
        ]
    )
    return str(payload["metadata"]["id"])


def first_subnet_id() -> str:
    payload = run_json(["nebius", "vpc", "subnet", "list", "--format", "json"])
    items = payload.get("items") or []
    if not items:
        raise RuntimeError("No Nebius subnets found in the active profile.")
    return str(items[0]["metadata"]["id"])


def find_instance_id_by_name(*, project_id: str, name: str) -> str | None:
    payload = run_json(["nebius", "compute", "instance", "list", "--format", "json"])
    items = payload.get("items") or []
    for item in items:
        metadata = item.get("metadata") or {}
        if str(metadata.get("name")) != name:
            continue
        if project_id and str(metadata.get("parent_id")) != project_id:
            continue
        instance_id = metadata.get("id")
        if instance_id:
            return str(instance_id)
    return None


def disk_attachment_instance_id(disk_id: str) -> str | None:
    payload = run_json(["nebius", "compute", "disk", "list", "--format", "json"])
    items = payload.get("items") or []
    for item in items:
        metadata = item.get("metadata") or {}
        if str(metadata.get("id")) != disk_id:
            continue
        status = item.get("status") or {}
        attachment = status.get("read_write_attachment")
        if attachment:
            return str(attachment)
        return None
    return None


def wait_for_disk_detach(disk_id: str, *, timeout_seconds: int = 180) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        attachment = disk_attachment_instance_id(disk_id)
        if attachment is None:
            return
        time.sleep(5)
    raise TimeoutError(f"Disk {disk_id} is still attached after {timeout_seconds}s")


def create_instance(
    *,
    project_id: str,
    name: str,
    platform: str,
    preset: str,
    subnet_id: str,
    boot_disk_id: str,
    cloud_init_user_data: str,
) -> str:
    network_interfaces = json.dumps(
        [
            {
                "name": "eth0",
                "subnet_id": subnet_id,
                "ip_address": {},
                "public_ip_address": {"static": False},
            }
        ]
    )
    completed = run_command(
        [
            "nebius",
            "compute",
            "instance",
            "create",
            "--format",
            "json",
            "--name",
            name,
            "--parent-id",
            project_id,
            "--cloud-init-user-data",
            cloud_init_user_data,
            "--resources-platform",
            platform,
            "--resources-preset",
            preset,
            "--boot-disk-attach-mode",
            "read_write",
            "--boot-disk-existing-disk-id",
            boot_disk_id,
            "--network-interfaces",
            network_interfaces,
        ],
        check=False,
    )
    if completed.returncode != 0:
        stderr = "\n".join(
            part.strip() for part in [completed.stdout, completed.stderr] if part and part.strip()
        )
        quota_message = quota_error_message(stderr)
        detail = quota_message or stderr or "Nebius CLI returned no error details."
        raise RuntimeError(f"Failed to create Nebius instance {name}: {detail}")
    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError(f"Instance creation for {name} returned no JSON output.")
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Instance creation for {name} returned invalid JSON:\n{stdout}"
        ) from exc
    return str(payload["metadata"]["id"])


def delete_boot_disk(disk_id: str) -> subprocess.CompletedProcess[str]:
    return run_command(
        [
            "nebius",
            "compute",
            "disk",
            "delete",
            "--id",
            disk_id,
        ],
        check=False,
    )


def wait_for_public_ip(instance_name: str, timeout_seconds: int = 900) -> str:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        payload = run_json(
            [
                "nebius",
                "compute",
                "instance",
                "get-by-name",
                "--format",
                "json",
                "--name",
                instance_name,
            ]
        )
        interfaces = payload.get("status", {}).get("network_interfaces") or []
        if interfaces:
            address = interfaces[0].get("public_ip_address", {}).get("address", "").split("/")[0]
            if address:
                return address
        time.sleep(10)
    raise TimeoutError(f"Timed out waiting for public IP on {instance_name}")


def ssh_base_command(username: str, public_ip: str, ssh_key_path: Path) -> list[str]:
    return [
        "ssh",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-i",
        str(ssh_key_path),
        f"{username}@{public_ip}",
    ]


def ssh_noninteractive_command(username: str, public_ip: str, ssh_key_path: Path) -> list[str]:
    return [
        "ssh",
        "-n",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-i",
        str(ssh_key_path),
        f"{username}@{public_ip}",
    ]


def scp_base_command(ssh_key_path: Path) -> list[str]:
    return [
        "scp",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-i",
        str(ssh_key_path),
    ]


def relative_bundle_paths(
    weighted_export_dir: Path,
    unweighted_export_dir: Path,
    scenario_catalog: Path,
) -> list[Path]:
    return [
        remote_path
        for _local_path, remote_path in bundle_sync_entries(
            weighted_export_dir,
            unweighted_export_dir,
            scenario_catalog,
        )
    ]


def bundle_relative_path(path: Path) -> Path:
    resolved = path.resolve()
    try:
        return resolved.relative_to(WORKSPACE_ROOT)
    except ValueError:
        digest = hashlib.sha1(str(resolved).encode("utf-8")).hexdigest()[:12]
        return STAGED_INPUTS_ROOT / f"{digest}-{resolved.name}"


def bundle_sync_entries(
    weighted_export_dir: Path,
    unweighted_export_dir: Path,
    scenario_catalog: Path,
) -> list[tuple[Path, Path]]:
    return [
        (
            WORKSPACE_ROOT / "babylon/packages/training/python/scripts",
            Path("babylon/packages/training/python/scripts"),
        ),
        (
            WORKSPACE_ROOT / "babylon/packages/training/python/src",
            Path("babylon/packages/training/python/src"),
        ),
        (
            WORKSPACE_ROOT / "babylon/packages/training/python/requirements.txt",
            Path("babylon/packages/training/python/requirements.txt"),
        ),
        (
            WORKSPACE_ROOT / "babylon/packages/training/python/pyproject.toml",
            Path("babylon/packages/training/python/pyproject.toml"),
        ),
        (
            WORKSPACE_ROOT / "babylon/packages/training/python/setup.py",
            Path("babylon/packages/training/python/setup.py"),
        ),
        (weighted_export_dir.resolve(), bundle_relative_path(weighted_export_dir)),
        (unweighted_export_dir.resolve(), bundle_relative_path(unweighted_export_dir)),
        (scenario_catalog.resolve(), bundle_relative_path(scenario_catalog)),
    ]


def sync_workspace_subset(
    *,
    weighted_export_dir: Path,
    unweighted_export_dir: Path,
    scenario_catalog: Path,
    remote_user: str,
    public_ip: str,
    ssh_key_path: Path,
    remote_workspace: str,
) -> None:
    bundle_entries = bundle_sync_entries(
        weighted_export_dir,
        unweighted_export_dir,
        scenario_catalog,
    )
    ssh_cmd = ssh_noninteractive_command(remote_user, public_ip, ssh_key_path)
    rsync_base = [
        "rsync",
        "-az",
        "--delete",
        "-e",
        " ".join(
            [
                "ssh",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-i",
                str(ssh_key_path),
            ]
        ),
    ]
    for pattern in RSYNC_EXCLUDES:
        rsync_base.extend(["--exclude", pattern])

    for full_path, relative_path in bundle_entries:
        if not full_path.exists():
            raise FileNotFoundError(f"Sync path does not exist: {full_path}")

        remote_parent = f"{remote_workspace}/{relative_path.parent}"
        run_command(
            [*ssh_cmd, f"mkdir -p {shlex.quote(remote_parent)}"],
            capture=False,
        )

        if full_path.is_dir():
            run_command(
                [
                    *rsync_base,
                    f"{full_path}/",
                    f"{remote_user}@{public_ip}:{remote_workspace}/{relative_path}/",
                ],
                capture=False,
            )
        else:
            run_command(
                [
                    *rsync_base,
                    str(full_path),
                    f"{remote_user}@{public_ip}:{remote_workspace}/{relative_path}",
                ],
                capture=False,
            )


def render_remote_script(args: argparse.Namespace) -> str:
    workspace = shlex.quote(args.remote_workspace)
    python_root = f"{workspace}/babylon/packages/training/python"
    weighted_dir = remote_workspace_path(workspace, args.weighted_export_dir)
    unweighted_dir = remote_workspace_path(workspace, args.unweighted_export_dir)
    scenario_catalog = remote_workspace_path(workspace, args.scenario_catalog)
    results_dir = f"{workspace}/{args.remote_results_dir}"

    def eval_command(
        label: str, model: str, adapter_path: str | None = None, tokenizer_model: str | None = None
    ) -> str:
        eval_cache_implementation = getattr(args, "eval_cache_implementation", "dynamic")
        parts = [
            "python3",
            f"{python_root}/scripts/run_scambench_local.py",
            "--backend",
            "transformers",
            "--device",
            "cuda",
            "--dtype",
            "bfloat16",
            "--base-model",
            shlex.quote(model),
            "--label",
            shlex.quote(label),
            "--output",
            shlex.quote(f"{results_dir}/{label}-decisions.json"),
            "--scenario-catalog",
            shlex.quote(scenario_catalog),
            "--max-tokens",
            str(args.max_tokens),
            "--score",
            "--cache-implementation",
            eval_cache_implementation,
        ]
        if adapter_path:
            parts.extend(["--adapter-path", shlex.quote(adapter_path)])
        if tokenizer_model:
            parts.extend(["--tokenizer-model", shlex.quote(tokenizer_model)])
        if eval_cache_implementation == "turboquant":
            parts.extend(
                [
                    "--turboquant-key-bits",
                    str(getattr(args, "eval_turboquant_key_bits", 3.5)),
                    "--turboquant-value-bits",
                    str(getattr(args, "eval_turboquant_value_bits", 3.5)),
                    "--turboquant-residual-length",
                    str(getattr(args, "eval_turboquant_residual_length", 128)),
                    "--turboquant-seed",
                    str(getattr(args, "eval_turboquant_seed", 0)),
                ]
            )
        return " ".join(parts)

    def train_command(
        *,
        label: str,
        source_dir: str,
        optimizer: str,
        lora: bool,
        lr: float,
        quantization: str,
    ) -> str:
        parts = [
            "python3",
            f"{python_root}/scripts/train_local.py",
            "--backend",
            "cuda",
            "--source-dir",
            shlex.quote(source_dir),
            "--model",
            shlex.quote(args.base_model),
            "--output",
            shlex.quote(f"{workspace}/babylon/trained_models/{label}"),
            "--auto-detect-held-out",
            "--max-steps",
            str(args.max_steps),
            "--batch-size",
            str(args.batch_size),
            "--gradient-accumulation-steps",
            str(args.gradient_accumulation_steps),
            "--max-seq-length",
            str(args.max_seq_length),
            "--lr",
            str(lr),
            "--optimizer",
            optimizer,
            "--quantization",
            quantization,
            "--validate",
        ]
        if lora:
            parts.append("--lora")
        else:
            parts.append("--no-lora")
        if optimizer == "apollo":
            parts.extend(
                [
                    "--apollo-rank",
                    str(args.apollo_rank),
                    "--apollo-scale",
                    str(args.apollo_scale),
                    "--apollo-update-proj-gap",
                    str(args.apollo_update_proj_gap),
                ]
            )
        return " ".join(parts)

    matrix = build_matrix(args)
    matrix_json = json.dumps(matrix)
    return textwrap.dedent(
        f"""\
        set -euo pipefail

        export DEBIAN_FRONTEND=noninteractive
        export PYTHONUNBUFFERED=1
        mkdir -p {workspace}
        mkdir -p {results_dir}
        cd {workspace}

        echo "=== Pre-setup diagnostics ==="
        free -h
        df -h /
        nvidia-smi || echo "nvidia-smi not available yet"

        rm -rf .venv
        python3 -m venv .venv
        . .venv/bin/activate
        python -m pip install --upgrade pip wheel setuptools
        python -m pip install \
          torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
          --index-url https://download.pytorch.org/whl/cu124
        python -m pip install \
          python-dotenv pydantic PyYAML numpy tqdm psutil jsonlines requests \
          transformers datasets peft accelerate bitsandbytes sentencepiece protobuf apollo-torch

        echo "=== Post-install diagnostics ==="
        free -h
        df -h /
        nvidia-smi

        python - <<'PY'
        import json
        import subprocess
        from pathlib import Path

        matrix = json.loads({json.dumps(matrix_json)})
        results_dir = Path({json.dumps(results_dir)})
        results_dir.mkdir(parents=True, exist_ok=True)

        for item in matrix:
            train_output_dir = Path(item["train_output_dir"]) if item.get("train_output_dir") else None
            eval_output_path = Path(item["eval_output_path"])
            score_output_path = Path(item["score_output_path"])

            if eval_output_path.exists() and score_output_path.exists():
                print(
                    f"[resume] skipping variant for {{item['id']}} because "
                    f"{{eval_output_path.name}} and {{score_output_path.name}} already exist"
                )
                continue

            if item["train"] and train_output_dir is not None:
                training_manifest = train_output_dir / "training_manifest.json"
                if training_manifest.exists():
                    print(f"[resume] skipping train for {{item['id']}} because {{training_manifest}} already exists")
                else:
                    subprocess.run(item["train"], shell=True, check=True)
            elif item["train"]:
                subprocess.run(item["train"], shell=True, check=True)

            if eval_output_path.exists():
                print(f"[resume] skipping eval for {{item['id']}} because {{eval_output_path}} already exists")
            else:
                subprocess.run(item["eval"], shell=True, check=True)

        summary = []
        for score_path in sorted(results_dir.glob("*-score.json")):
            payload = json.loads(score_path.read_text())
            summary.append({{
                "label": payload.get("handler"),
                "overallScore": payload.get("overallScore"),
                "intentResults": payload.get("intentResults"),
                "categoryResults": payload.get("categoryResults"),
                "scorePath": str(score_path),
            }})

        (results_dir / "matrix-summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary, indent=2))
        PY
        """
    )


def build_matrix(args: argparse.Namespace) -> list[dict[str, Any]]:
    workspace = shlex.quote(args.remote_workspace)
    python_root = f"{workspace}/babylon/packages/training/python"
    weighted_dir = remote_workspace_path(workspace, args.weighted_export_dir)
    unweighted_dir = remote_workspace_path(workspace, args.unweighted_export_dir)
    scenario_catalog = remote_workspace_path(workspace, args.scenario_catalog)
    results_dir = f"{workspace}/{args.remote_results_dir}"
    model_name_slug = model_slug(args.base_model)
    source_dirs = {
        "weighted": weighted_dir,
        "unweighted": unweighted_dir,
    }

    def eval_command(
        label: str, model: str, adapter_path: str | None = None, tokenizer_model: str | None = None
    ) -> str:
        eval_cache_implementation = getattr(args, "eval_cache_implementation", "dynamic")
        parts = [
            "python3",
            f"{python_root}/scripts/run_scambench_local.py",
            "--backend",
            "transformers",
            "--device",
            "cuda",
            "--dtype",
            "bfloat16",
            "--base-model",
            shlex.quote(model),
            "--label",
            shlex.quote(label),
            "--output",
            shlex.quote(f"{results_dir}/{label}-decisions.json"),
            "--scenario-catalog",
            shlex.quote(scenario_catalog),
            "--max-tokens",
            str(args.max_tokens),
            "--score",
            "--cache-implementation",
            eval_cache_implementation,
        ]
        if adapter_path:
            parts.extend(["--adapter-path", shlex.quote(adapter_path)])
        if tokenizer_model:
            parts.extend(["--tokenizer-model", shlex.quote(tokenizer_model)])
        if eval_cache_implementation == "turboquant":
            parts.extend(
                [
                    "--turboquant-key-bits",
                    str(getattr(args, "eval_turboquant_key_bits", 3.5)),
                    "--turboquant-value-bits",
                    str(getattr(args, "eval_turboquant_value_bits", 3.5)),
                    "--turboquant-residual-length",
                    str(getattr(args, "eval_turboquant_residual_length", 128)),
                    "--turboquant-seed",
                    str(getattr(args, "eval_turboquant_seed", 0)),
                ]
            )
        return " ".join(parts)

    def train_command(
        *,
        label: str,
        source_dir: str,
        optimizer: str,
        lora: bool,
        lr: float,
        quantization: str,
    ) -> str:
        parts = [
            "python3",
            f"{python_root}/scripts/train_local.py",
            "--backend",
            "cuda",
            "--source-dir",
            shlex.quote(source_dir),
            "--model",
            shlex.quote(args.base_model),
            "--output",
            shlex.quote(f"{workspace}/babylon/trained_models/{label}"),
            "--auto-detect-held-out",
            "--max-steps",
            str(args.max_steps),
            "--batch-size",
            str(args.batch_size),
            "--gradient-accumulation-steps",
            str(args.gradient_accumulation_steps),
            "--max-seq-length",
            str(args.max_seq_length),
            "--lr",
            str(lr),
            "--optimizer",
            optimizer,
            "--quantization",
            quantization,
            "--validate",
        ]
        if lora:
            parts.append("--lora")
        else:
            parts.append("--no-lora")
        if optimizer == "apollo":
            parts.extend(
                [
                    "--apollo-rank",
                    str(args.apollo_rank),
                    "--apollo-scale",
                    str(args.apollo_scale),
                    "--apollo-update-proj-gap",
                    str(args.apollo_update_proj_gap),
                ]
            )
        return " ".join(parts)

    matrix: list[dict[str, Any]] = []
    for spec in MATRIX_VARIANT_SPECS:
        label = variant_label(model_name_slug, spec.variant_id)
        eval_output_path = f"{results_dir}/{label}-decisions.json"
        variant_score_output_path = score_output_path(eval_output_path)
        if spec.source_key is None:
            matrix.append(
                {
                    "id": spec.variant_id,
                    "kind": spec.kind,
                    "train": None,
                    "train_output_dir": None,
                    "eval_output_path": eval_output_path,
                    "score_output_path": variant_score_output_path,
                    "eval": eval_command(
                        label,
                        args.base_model,
                        tokenizer_model=args.base_model,
                    ),
                }
            )
            continue

        train_output_dir = variant_training_output_dir(
            workspace,
            model_name_slug,
            spec.variant_id,
        )
        train_label = variant_training_label(model_name_slug, spec.variant_id)
        train_lr = getattr(args, str(spec.learning_rate_attr))
        eval_model = args.base_model if spec.lora else train_output_dir
        eval_adapter_path = train_output_dir if spec.lora else None
        eval_tokenizer_model = args.base_model if spec.lora else None
        matrix.append(
            {
                "id": spec.variant_id,
                "kind": spec.kind,
                "train_output_dir": train_output_dir,
                "eval_output_path": eval_output_path,
                "score_output_path": variant_score_output_path,
                "train": train_command(
                    label=train_label,
                    source_dir=source_dirs[str(spec.source_key)],
                    optimizer=str(spec.optimizer),
                    lora=bool(spec.lora),
                    lr=train_lr,
                    quantization=(
                        getattr(args, "lora_quantization", "none")
                        if spec.kind == "lora"
                        else "none"
                    ),
                ),
                "eval": eval_command(
                    label,
                    eval_model,
                    adapter_path=eval_adapter_path,
                    tokenizer_model=eval_tokenizer_model,
                ),
            }
        )
    return filter_matrix(matrix, getattr(args, "variants", DEFAULT_VARIANTS))


def parse_variants(value: str) -> list[str]:
    items = [item.strip() for item in value.split(",")]
    variants = [item for item in items if item]
    if not variants:
        raise argparse.ArgumentTypeError("At least one matrix variant is required.")
    unknown = [item for item in variants if item not in DEFAULT_VARIANTS]
    if unknown:
        raise argparse.ArgumentTypeError(
            f"Unknown variants: {', '.join(unknown)}. Expected one of: {', '.join(DEFAULT_VARIANTS)}"
        )
    return variants


def filter_matrix(matrix: list[dict[str, Any]], variants: list[str]) -> list[dict[str, Any]]:
    wanted = set(variants)
    filtered = [item for item in matrix if item["id"] in wanted]
    if len(filtered) != len(wanted):
        present = {item["id"] for item in filtered}
        missing = [item for item in variants if item not in present]
        raise ValueError(f"Missing requested variants in matrix: {', '.join(missing)}")
    return filtered


def resolve_vm_shape(
    *,
    base_model: str,
    gpu_type: str,
    platform: str | None,
    preset: str | None,
    max_seq_length: int,
    batch_size: int,
    apollo_rank: int,
) -> tuple[str, str, QwenModelSpec | None]:
    spec = resolve_model_spec(base_model)
    if spec is not None and spec.key == "qwen35_122b_a10b":
        raise ValueError(
            f"{base_model} is a cluster-sized target and is not supported by this single-VM Nebius runner."
        )

    fallback_shape = NEBIUS_VM_SHAPES[gpu_type]
    if platform is not None or preset is not None:
        return platform or fallback_shape.platform, preset or fallback_shape.preset, spec
    if spec is None:
        return fallback_shape.platform, fallback_shape.preset, None

    recommended = recommend_nebius_vm_shape(
        spec,
        gpu=gpu_type,
        sequence_length=max_seq_length,
        micro_batch_size=max(1, batch_size),
        apollo_rank=apollo_rank,
    )
    if recommended is None:
        raise ValueError(
            f"{spec.display_name} does not fit a single {gpu_type.upper()} VM for APOLLO training "
            f"at max_seq_length={max_seq_length}, batch_size={batch_size}, apollo_rank={apollo_rank}. "
            "Use a shorter sequence, smaller micro-batch, a larger GPU type, or a distributed recipe."
        )
    return recommended.platform, recommended.preset, spec


def build_args() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the unified ScamBench matrix on Nebius.")
    parser.add_argument(
        "--project-id", default=None, help="Nebius project ID (defaults from CLI config)."
    )
    parser.add_argument("--instance-name", default=f"scambench-unified-{int(time.time())}")
    parser.add_argument(
        "--existing-host",
        default=None,
        help="Reuse an existing Nebius VM by public IP or hostname.",
    )
    parser.add_argument("--existing-user", default=None, help="SSH user for --existing-host.")
    parser.add_argument("--gpu-type", choices=["h100", "h200"], default="h100")
    parser.add_argument("--platform", default=None)
    parser.add_argument("--preset", default=None)
    parser.add_argument("--boot-image-family", default="ubuntu22.04-cuda12")
    parser.add_argument("--boot-disk-size-gib", type=int, default=300)
    parser.add_argument("--username", default="trainer")
    parser.add_argument("--ssh-key", default=str(Path.home() / ".ssh" / "id_ed25519.pub"))
    parser.add_argument("--ssh-private-key", default=str(Path.home() / ".ssh" / "id_ed25519"))
    parser.add_argument("--remote-workspace", default="/home/trainer/babylon-workspace")
    parser.add_argument("--remote-results-dir", default="babylon/runs/nebius-unified/latest")
    parser.add_argument("--weighted-export-dir", type=Path, default=DEFAULT_WEIGHTED_EXPORT)
    parser.add_argument("--unweighted-export-dir", type=Path, default=DEFAULT_UNWEIGHTED_EXPORT)
    parser.add_argument("--scenario-catalog", type=Path, default=DEFAULT_SCENARIO_CATALOG)
    parser.add_argument("--local-results-root", type=Path, default=DEFAULT_RESULTS_ROOT)
    parser.add_argument("--base-model", default="Qwen/Qwen3.5-4B")
    parser.add_argument("--max-steps", type=int, default=120)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=4)
    parser.add_argument("--max-seq-length", type=int, default=768)
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument(
        "--eval-cache-implementation", choices=["dynamic", "turboquant"], default="dynamic"
    )
    parser.add_argument("--eval-turboquant-key-bits", type=float, default=3.5)
    parser.add_argument("--eval-turboquant-value-bits", type=float, default=3.5)
    parser.add_argument("--eval-turboquant-residual-length", type=int, default=128)
    parser.add_argument("--eval-turboquant-seed", type=int, default=0)
    parser.add_argument("--lora-learning-rate", type=float, default=1e-5)
    parser.add_argument("--lora-quantization", choices=["none", "nf4"], default="none")
    parser.add_argument("--apollo-learning-rate", type=float, default=5e-6)
    parser.add_argument("--apollo-rank", type=int, default=64)
    parser.add_argument("--apollo-scale", type=float, default=1.0)
    parser.add_argument("--apollo-update-proj-gap", type=int, default=200)
    parser.add_argument(
        "--variants",
        type=parse_variants,
        default=list(DEFAULT_VARIANTS),
        help="Comma-separated matrix variants to run/download.",
    )
    parser.add_argument(
        "--download-model-artifacts",
        action="store_true",
        help="Download trained model output directories for selected non-baseline variants.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--keep-instance", action="store_true")
    return parser


def build_model_download_command(
    *,
    ssh_key_path: Path,
    remote_user: str,
    public_ip: str,
    remote_model_dir: str,
    local_model_dir: Path,
) -> list[str]:
    command = [
        "rsync",
        "-a",
        "--partial",
        "--prune-empty-dirs",
        "-e",
        " ".join(
            [
                "ssh",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-i",
                str(ssh_key_path),
            ]
        ),
        "--include",
        "*/",
    ]
    for pattern in MODEL_DOWNLOAD_PATTERNS:
        command.extend(["--include", pattern])
    command.extend(
        [
            "--exclude",
            "*",
            f"{remote_user}@{public_ip}:{remote_model_dir}/",
            f"{local_model_dir}/",
        ]
    )
    return command


def main() -> int:
    parser = build_args()
    args = parser.parse_args()

    args.project_id = args.project_id or nebius_config_value("parent-id")
    args.platform, args.preset, resolved_spec = resolve_vm_shape(
        base_model=args.base_model,
        gpu_type=args.gpu_type,
        platform=args.platform,
        preset=args.preset,
        max_seq_length=args.max_seq_length,
        batch_size=args.batch_size,
        apollo_rank=args.apollo_rank,
    )
    if args.dry_run:
        bundle_paths = relative_bundle_paths(
            weighted_export_dir=args.weighted_export_dir,
            unweighted_export_dir=args.unweighted_export_dir,
            scenario_catalog=args.scenario_catalog,
        )
        print(f"Project: {args.project_id}")
        print(f"Instance: {args.instance_name}")
        print(f"GPU type: {args.gpu_type}")
        print(f"Platform: {args.platform}")
        print(f"Preset: {args.preset}")
        if resolved_spec is not None:
            print(f"Resolved model: {resolved_spec.display_name} ({resolved_spec.slug})")
        print("Bundle paths:")
        for path in bundle_paths:
            print(f"  - {path}")
        print(render_remote_script(args))
        return 0

    ssh_private_key = Path(args.ssh_private_key).resolve()

    print(f"Project: {args.project_id}")
    print(f"Instance: {args.instance_name}")
    print(f"GPU type: {args.gpu_type}")
    print(f"Platform: {args.platform}")
    print(f"Preset: {args.preset}")
    if resolved_spec is not None:
        print(f"Resolved model: {resolved_spec.display_name} ({resolved_spec.slug})")

    instance_id: str | None = None
    boot_disk_id: str | None = None
    public_ip: str
    remote_username = args.existing_user or args.username
    try:
        if args.existing_host:
            public_ip = args.existing_host
            print(f"Reusing existing host: {public_ip} as {remote_username}")
        else:
            ensure_nebius_auth()
            subnet_id = first_subnet_id()
            print(f"Subnet: {subnet_id}")
            boot_disk_id = create_boot_disk(
                project_id=args.project_id,
                name=f"{args.instance_name}-boot",
                size_gib=args.boot_disk_size_gib,
                image_family=args.boot_image_family,
            )
            print(f"Created boot disk: {boot_disk_id}")

            public_key = Path(args.ssh_key).read_text(encoding="utf-8").strip()
            cloud_init = build_cloud_init_user_data(args.username, public_key)
            try:
                instance_id = create_instance(
                    project_id=args.project_id,
                    name=args.instance_name,
                    platform=args.platform,
                    preset=args.preset,
                    subnet_id=subnet_id,
                    boot_disk_id=boot_disk_id,
                    cloud_init_user_data=cloud_init,
                )
            except Exception:
                if not args.keep_instance:
                    instance_id = find_instance_id_by_name(
                        project_id=args.project_id,
                        name=args.instance_name,
                    )
                raise
            print(f"Created instance: {instance_id}")

            public_ip = wait_for_public_ip(args.instance_name)
            print(f"Public IP: {public_ip}")

        # Wait for SSH to become available (cloud-init may still be running)
        print("Waiting for SSH to become available...")
        ssh_ready = False
        for attempt in range(30):
            try:
                subprocess.run(
                    [
                        "ssh",
                        "-n",
                        "-o",
                        "StrictHostKeyChecking=accept-new",
                        "-o",
                        "ConnectTimeout=5",
                        "-i",
                        str(ssh_private_key),
                        f"{remote_username}@{public_ip}",
                        "echo ready",
                    ],
                    check=True,
                    capture_output=True,
                    timeout=15,
                )
                ssh_ready = True
                print(f"SSH ready after {(attempt + 1) * 10}s")
                break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                time.sleep(10)
        if not ssh_ready:
            raise TimeoutError(f"SSH not available on {public_ip} after 300s")

        sync_workspace_subset(
            weighted_export_dir=args.weighted_export_dir,
            unweighted_export_dir=args.unweighted_export_dir,
            scenario_catalog=args.scenario_catalog,
            remote_user=remote_username,
            public_ip=public_ip,
            ssh_key_path=ssh_private_key,
            remote_workspace=args.remote_workspace,
        )

        matrix = build_matrix(args)
        remote_script = render_remote_script(args)
        bootstrap_cmd = [
            *ssh_base_command(remote_username, public_ip, ssh_private_key),
            f"mkdir -p {shlex.quote(args.remote_workspace)} && bash -s",
        ]
        subprocess.run(
            bootstrap_cmd,
            input=remote_script,
            text=True,
            check=True,
        )

        timestamp = time.strftime("%Y%m%d-%H%M%S")
        local_results_dir = args.local_results_root / timestamp
        local_results_dir.mkdir(parents=True, exist_ok=True)
        download_cmd = [
            *scp_base_command(ssh_private_key),
            "-r",
            f"{remote_username}@{public_ip}:{args.remote_workspace}/{args.remote_results_dir}/.",
            str(local_results_dir),
        ]
        run_command(download_cmd, capture=False)
        print(f"Downloaded results to {local_results_dir}")

        if args.download_model_artifacts:
            for item in matrix:
                train_output_dir = item.get("train_output_dir")
                if not train_output_dir:
                    continue
                local_model_dir = local_results_dir / "model-artifacts" / item["id"]
                local_model_dir.mkdir(parents=True, exist_ok=True)
                rsync_cmd = build_model_download_command(
                    ssh_key_path=ssh_private_key,
                    remote_user=remote_username,
                    public_ip=public_ip,
                    remote_model_dir=train_output_dir,
                    local_model_dir=local_model_dir,
                )
                run_command(rsync_cmd, capture=False)
                print(f"Downloaded model artifacts for {item['id']} to {local_model_dir}")
    finally:
        if instance_id and not args.keep_instance:
            delete_instance = run_command(
                [
                    "nebius",
                    "compute",
                    "instance",
                    "delete",
                    "--id",
                    instance_id,
                ],
                check=False,
            )
            if delete_instance.returncode == 0:
                print(f"Deleted instance {instance_id}")
            else:
                stderr = (delete_instance.stderr or "").strip()
                print(
                    f"Failed to delete instance {instance_id}: {stderr or 'unknown error'}",
                    file=sys.stderr,
                )
        if boot_disk_id and not args.keep_instance:
            try:
                wait_for_disk_detach(boot_disk_id)
            except TimeoutError as exc:
                print(str(exc), file=sys.stderr)
            disk_delete = delete_boot_disk(boot_disk_id)
            if disk_delete.returncode == 0:
                print(f"Deleted boot disk {boot_disk_id}")
            else:
                stderr = (disk_delete.stderr or "").strip()
                print(
                    f"Failed to delete boot disk {boot_disk_id}: {stderr or 'unknown error'}",
                    file=sys.stderr,
                )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
