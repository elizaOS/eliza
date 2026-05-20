import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

PYTHON_ROOT = Path(__file__).resolve().parent.parent


def load_script_module(module_name: str, script_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_first_script = Path(__file__).resolve().parent.parent / "scripts" / "run_nebius_unified_matrix.py"
if not _first_script.exists():
    pytest.skip("script not found: run_nebius_unified_matrix.py", allow_module_level=True)

nebius_script = load_script_module(
    "run_nebius_unified_matrix",
    PYTHON_ROOT / "scripts" / "run_nebius_unified_matrix.py",
)


def test_build_cloud_init_user_data_embeds_username_and_key():
    payload = nebius_script.build_cloud_init_user_data(
        "trainer",
        "ssh-ed25519 AAAATEST trainer@example",
    )

    assert "name: trainer" in payload
    assert "ssh-ed25519 AAAATEST trainer@example" in payload
    assert "python3-venv" in payload


def test_relative_bundle_paths_cover_training_and_catalog_exports():
    weighted = nebius_script.DEFAULT_WEIGHTED_EXPORT
    unweighted = nebius_script.DEFAULT_UNWEIGHTED_EXPORT
    catalog = nebius_script.DEFAULT_SCENARIO_CATALOG

    paths = nebius_script.relative_bundle_paths(weighted, unweighted, catalog)

    assert Path("babylon/packages/training/python/scripts") in paths
    assert Path("babylon/packages/training/python/src") in paths
    assert Path("babylon/packages/training/python/requirements.txt") in paths
    assert weighted.resolve().relative_to(nebius_script.WORKSPACE_ROOT) in paths
    assert unweighted.resolve().relative_to(nebius_script.WORKSPACE_ROOT) in paths
    assert catalog.resolve().relative_to(nebius_script.WORKSPACE_ROOT) in paths


def test_relative_bundle_paths_stage_external_catalog(tmp_path: Path):
    external_catalog = tmp_path / "catalog.json"
    external_catalog.write_text("{}", encoding="utf-8")

    paths = nebius_script.relative_bundle_paths(
        nebius_script.DEFAULT_WEIGHTED_EXPORT,
        nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        external_catalog,
    )

    staged_paths = [
        path for path in paths if str(path).startswith(str(nebius_script.STAGED_INPUTS_ROOT))
    ]
    assert len(staged_paths) == 1
    assert staged_paths[0].name.endswith("-catalog.json")


def test_remote_workspace_path_uses_staged_location_for_external_inputs(tmp_path: Path):
    external_catalog = tmp_path / "catalog.json"
    external_catalog.write_text("{}", encoding="utf-8")

    remote_path = nebius_script.remote_workspace_path(
        "/home/trainer/babylon-workspace",
        external_catalog,
    )

    assert remote_path.startswith("/home/trainer/babylon-workspace/")
    assert "/babylon/runs/nebius-unified/_inputs/" in remote_path


def test_render_remote_script_contains_baseline_lora_and_apollo_steps():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-4B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        eval_cache_implementation="dynamic",
        eval_turboquant_key_bits=3.5,
        eval_turboquant_value_bits=3.5,
        eval_turboquant_residual_length=128,
        eval_turboquant_seed=0,
        lora_learning_rate=1e-5,
        lora_quantization="none",
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=list(nebius_script.DEFAULT_VARIANTS),
    )

    script = nebius_script.render_remote_script(args)

    assert "baseline-qwen35-4b-unified-nebius" in script
    assert "lora-unweighted-qwen35-4b-unified-nebius" in script
    assert "lora-weighted-qwen35-4b-unified-nebius" in script
    assert "apollo-unweighted-qwen35-4b-unified-nebius" in script
    assert "apollo-weighted-qwen35-4b-unified-nebius" in script
    assert "--backend transformers" in script
    assert "--optimizer apollo" in script
    assert "--no-lora" in script
    assert "--quantization none" in script
    assert "--cache-implementation dynamic" in script


def test_parse_variants_accepts_subset_and_rejects_unknown():
    assert nebius_script.parse_variants("baseline,apollo-unweighted") == [
        "baseline",
        "apollo-unweighted",
    ]

    try:
        nebius_script.parse_variants("baseline,unknown")
    except argparse.ArgumentTypeError as exc:
        assert "Unknown variants" in str(exc)
    else:
        raise AssertionError("Expected argparse.ArgumentTypeError for unknown variant")


def test_parse_variants_rejects_empty_value():
    try:
        nebius_script.parse_variants(" , ")
    except argparse.ArgumentTypeError as exc:
        assert "At least one matrix variant is required" in str(exc)
    else:
        raise AssertionError("Expected argparse.ArgumentTypeError for empty variant list")


def test_score_output_path_uses_decisions_suffix():
    assert (
        nebius_script.score_output_path("/tmp/baseline-qwen35-9b-unified-nebius-decisions.json")
        == "/tmp/baseline-qwen35-9b-unified-nebius-decisions-score.json"
    )


def test_build_matrix_filters_to_requested_variants():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-4B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        eval_cache_implementation="dynamic",
        eval_turboquant_key_bits=3.5,
        eval_turboquant_value_bits=3.5,
        eval_turboquant_residual_length=128,
        eval_turboquant_seed=0,
        lora_learning_rate=1e-5,
        lora_quantization="none",
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=["apollo-unweighted"],
    )

    matrix = nebius_script.build_matrix(args)

    assert [item["id"] for item in matrix] == ["apollo-unweighted"]
    assert matrix[0]["score_output_path"].endswith(
        "apollo-unweighted-qwen35-4b-unified-nebius-decisions-score.json"
    )


def test_build_matrix_uses_adapter_only_for_lora_variants():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-4B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        eval_cache_implementation="dynamic",
        eval_turboquant_key_bits=3.5,
        eval_turboquant_value_bits=3.5,
        eval_turboquant_residual_length=128,
        eval_turboquant_seed=0,
        lora_learning_rate=1e-5,
        lora_quantization="none",
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=["lora-unweighted", "apollo-unweighted"],
    )

    matrix = nebius_script.build_matrix(args)

    assert "--adapter-path" in matrix[0]["eval"]
    assert "--tokenizer-model" in matrix[0]["eval"]
    assert "--adapter-path" not in matrix[1]["eval"]
    assert "--tokenizer-model" not in matrix[1]["eval"]


def test_render_remote_script_uses_variant_subset():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-4B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        eval_cache_implementation="dynamic",
        eval_turboquant_key_bits=3.5,
        eval_turboquant_value_bits=3.5,
        eval_turboquant_residual_length=128,
        eval_turboquant_seed=0,
        lora_learning_rate=1e-5,
        lora_quantization="none",
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=["apollo-unweighted"],
    )

    script = nebius_script.render_remote_script(args)

    assert "apollo-unweighted-qwen35-4b-unified-nebius" in script
    assert "lora-unweighted-qwen35-4b-unified-nebius" not in script
    assert "baseline-qwen35-4b-unified-nebius" not in script


def test_render_remote_script_interpolates_resume_logging_values():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-4B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        eval_cache_implementation="dynamic",
        eval_turboquant_key_bits=3.5,
        eval_turboquant_value_bits=3.5,
        eval_turboquant_residual_length=128,
        eval_turboquant_seed=0,
        lora_learning_rate=1e-5,
        lora_quantization="none",
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=["baseline"],
    )

    script = nebius_script.render_remote_script(args)

    assert "[resume] skipping train for {{item['id']}}" not in script
    assert "[resume] skipping eval for {{item['id']}}" not in script
    assert "print(f\"[resume] skipping train for {item['id']}" in script
    assert "print(f\"[resume] skipping eval for {item['id']}" in script
    assert "f\"[resume] skipping variant for {item['id']} because \"" in script


def test_build_matrix_sets_nf4_only_for_lora_variants():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-4B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        eval_cache_implementation="dynamic",
        eval_turboquant_key_bits=3.5,
        eval_turboquant_value_bits=3.5,
        eval_turboquant_residual_length=128,
        eval_turboquant_seed=0,
        lora_learning_rate=1e-5,
        lora_quantization="nf4",
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=["lora-unweighted", "apollo-unweighted"],
    )

    matrix = nebius_script.build_matrix(args)

    assert "--quantization nf4" in matrix[0]["train"]
    assert "--quantization none" in matrix[1]["train"]


def test_build_matrix_adds_turboquant_eval_flags_when_requested():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-4B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        eval_cache_implementation="turboquant",
        eval_turboquant_key_bits=3.5,
        eval_turboquant_value_bits=2.5,
        eval_turboquant_residual_length=64,
        eval_turboquant_seed=9,
        lora_learning_rate=1e-5,
        lora_quantization="none",
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=["baseline"],
    )

    matrix = nebius_script.build_matrix(args)

    assert "--cache-implementation turboquant" in matrix[0]["eval"]
    assert "--turboquant-key-bits 3.5" in matrix[0]["eval"]
    assert "--turboquant-value-bits 2.5" in matrix[0]["eval"]
    assert "--turboquant-residual-length 64" in matrix[0]["eval"]
    assert "--turboquant-seed 9" in matrix[0]["eval"]


def test_run_nebius_matrix_cli_dry_run_outputs_resolved_plan():
    proc = subprocess.run(
        [
            sys.executable,
            str(PYTHON_ROOT / "scripts" / "run_nebius_unified_matrix.py"),
            "--dry-run",
            "--project-id",
            "dry-run-project",
            "--base-model",
            "Qwen/Qwen3.5-9B",
            "--gpu-type",
            "h200",
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    assert "Project: dry-run-project" in proc.stdout
    assert "Resolved model: Qwen 3.5 9B (qwen35-9b)" in proc.stdout
    assert "baseline-qwen35-9b-unified-nebius" in proc.stdout
    assert "apollo-weighted-qwen35-9b-unified-nebius" in proc.stdout


def test_build_model_download_command_uses_partial_noncompressed_filtered_rsync(tmp_path: Path):
    command = nebius_script.build_model_download_command(
        ssh_key_path=Path("/tmp/test-key"),
        remote_user="research",
        public_ip="1.2.3.4",
        remote_model_dir="/remote/model",
        local_model_dir=tmp_path / "model",
    )

    assert command[:3] == ["rsync", "-a", "--partial"]
    assert "-z" not in command
    assert "--prune-empty-dirs" in command
    assert "research@1.2.3.4:/remote/model/" in command
    assert str(tmp_path / "model") + "/" in command
    assert "model.safetensors" in command
    assert "training_manifest.json" in command


def test_build_matrix_uses_model_slug_for_non_4b_models():
    args = argparse.Namespace(
        remote_workspace="/home/trainer/babylon-workspace",
        remote_results_dir="babylon/runs/nebius-unified/latest",
        weighted_export_dir=nebius_script.DEFAULT_WEIGHTED_EXPORT,
        unweighted_export_dir=nebius_script.DEFAULT_UNWEIGHTED_EXPORT,
        scenario_catalog=nebius_script.DEFAULT_SCENARIO_CATALOG,
        base_model="Qwen/Qwen3.5-9B",
        max_steps=120,
        batch_size=1,
        gradient_accumulation_steps=4,
        max_seq_length=768,
        max_tokens=128,
        lora_learning_rate=1e-5,
        apollo_learning_rate=5e-6,
        apollo_rank=64,
        apollo_scale=1.0,
        apollo_update_proj_gap=200,
        variants=["baseline", "apollo-unweighted"],
    )

    matrix = nebius_script.build_matrix(args)

    assert matrix[0]["eval_output_path"].endswith(
        "baseline-qwen35-9b-unified-nebius-decisions.json"
    )
    assert "qwen35-9b" in matrix[1]["train_output_dir"]


def test_resolve_vm_shape_rejects_122b_for_single_vm_runner():
    try:
        nebius_script.resolve_vm_shape(
            base_model="Qwen/Qwen3.5-122B-A10B",
            gpu_type="h200",
            platform=None,
            preset=None,
            max_seq_length=4096,
            batch_size=1,
            apollo_rank=64,
        )
    except ValueError as exc:
        assert "cluster-sized target" in str(exc)
    else:
        raise AssertionError("Expected ValueError for 122B single-VM request")


def test_resolve_vm_shape_accepts_9b_h100_at_matrix_defaults():
    platform, preset, spec = nebius_script.resolve_vm_shape(
        base_model="Qwen/Qwen3.5-9B",
        gpu_type="h100",
        platform=None,
        preset=None,
        max_seq_length=768,
        batch_size=1,
        apollo_rank=64,
    )

    assert platform == "gpu-h100-sxm"
    assert preset == "1gpu-16vcpu-200gb"
    assert spec is not None
    assert spec.slug == "qwen35-9b"


def test_quota_error_message_guides_existing_host_for_public_ip_limit():
    message = nebius_script.quota_error_message(
        "Quota limit exceeded. Exceeded limit for container tenant-123, "
        "quota vpc.ipv4-address.public.count (limit 3, requested 4)"
    )

    assert message is not None
    assert "--existing-host" in message
    assert "public IPv4 quota is exhausted" in message


def test_quota_error_message_parses_live_nebius_format_without_quota_prefix():
    message = nebius_script.quota_error_message(
        "Quota failure QuotaFailure: service VPC API, violations:\n"
        "    vpc.ipv4-address.public.count (limit 3, requested 4): "
        "Exceeded limit for container tenant-123"
    )

    assert message is not None
    assert "--existing-host" in message
    assert "public IPv4 quota is exhausted" in message


def test_create_instance_raises_actionable_public_ip_quota_error(monkeypatch):
    def fake_run_command(*_args, **_kwargs):
        return subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout="",
            stderr=(
                "Quota limit exceeded. Exceeded limit for container tenant-123, "
                "quota vpc.ipv4-address.public.count (limit 3, requested 4)"
            ),
        )

    monkeypatch.setattr(nebius_script, "run_command", fake_run_command)

    try:
        nebius_script.create_instance(
            project_id="project-1",
            name="scambench-unified",
            platform="gpu-h100-sxm",
            preset="1gpu-16vcpu-200gb",
            subnet_id="subnet-1",
            boot_disk_id="disk-1",
            cloud_init_user_data="users: []",
        )
    except RuntimeError as exc:
        assert "--existing-host" in str(exc)
        assert "disk-1" not in str(exc)
    else:
        raise AssertionError("Expected quota exhaustion to raise RuntimeError")


def test_main_deletes_boot_disk_after_instance_create_failure(monkeypatch, tmp_path: Path):
    ssh_pub = tmp_path / "id.pub"
    ssh_pub.write_text("ssh-ed25519 AAAATEST trainer@example\n", encoding="utf-8")
    ssh_private = tmp_path / "id"
    ssh_private.write_text("private-key", encoding="utf-8")
    deleted_disk_ids: list[str] = []

    monkeypatch.setattr(nebius_script, "nebius_config_value", lambda _key: "project-1")
    monkeypatch.setattr(nebius_script, "ensure_nebius_auth", lambda: None)
    monkeypatch.setattr(nebius_script, "first_subnet_id", lambda: "subnet-1")
    monkeypatch.setattr(nebius_script, "create_boot_disk", lambda **_kwargs: "disk-1")

    def fail_create_instance(**_kwargs):
        raise RuntimeError("create instance failed")

    def fake_delete_boot_disk(disk_id: str):
        deleted_disk_ids.append(disk_id)
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

    monkeypatch.setattr(nebius_script, "create_instance", fail_create_instance)
    monkeypatch.setattr(nebius_script, "delete_boot_disk", fake_delete_boot_disk)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "run_nebius_unified_matrix.py",
            "--project-id",
            "project-1",
            "--ssh-key",
            str(ssh_pub),
            "--ssh-private-key",
            str(ssh_private),
        ],
    )

    try:
        nebius_script.main()
    except RuntimeError as exc:
        assert str(exc) == "create instance failed"
    else:
        raise AssertionError("Expected instance creation failure to be propagated")

    assert deleted_disk_ids == ["disk-1"]


def test_main_deletes_partial_instance_after_failed_create(monkeypatch, tmp_path: Path):
    ssh_pub = tmp_path / "id.pub"
    ssh_pub.write_text("ssh-ed25519 AAAATEST trainer@example\n", encoding="utf-8")
    ssh_private = tmp_path / "id"
    ssh_private.write_text("private-key", encoding="utf-8")
    deleted_disk_ids: list[str] = []
    deleted_instance_ids: list[str] = []

    monkeypatch.setattr(nebius_script, "nebius_config_value", lambda _key: "project-1")
    monkeypatch.setattr(nebius_script, "ensure_nebius_auth", lambda: None)
    monkeypatch.setattr(nebius_script, "first_subnet_id", lambda: "subnet-1")
    monkeypatch.setattr(nebius_script, "create_boot_disk", lambda **_kwargs: "disk-1")
    monkeypatch.setattr(
        nebius_script,
        "find_instance_id_by_name",
        lambda **_kwargs: "instance-1",
    )
    monkeypatch.setattr(nebius_script, "wait_for_disk_detach", lambda _disk_id: None)

    def fail_create_instance(**_kwargs):
        raise RuntimeError("create instance failed")

    def fake_delete_boot_disk(disk_id: str):
        deleted_disk_ids.append(disk_id)
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

    def fake_run_command(command, **kwargs):
        if command[:5] == ["nebius", "compute", "instance", "delete", "--id"]:
            deleted_instance_ids.append(command[5])
            return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")
        raise AssertionError(f"Unexpected command: {command}")

    monkeypatch.setattr(nebius_script, "create_instance", fail_create_instance)
    monkeypatch.setattr(nebius_script, "delete_boot_disk", fake_delete_boot_disk)
    monkeypatch.setattr(nebius_script, "run_command", fake_run_command)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "run_nebius_unified_matrix.py",
            "--project-id",
            "project-1",
            "--ssh-key",
            str(ssh_pub),
            "--ssh-private-key",
            str(ssh_private),
        ],
    )

    try:
        nebius_script.main()
    except RuntimeError as exc:
        assert str(exc) == "create instance failed"
    else:
        raise AssertionError("Expected instance creation failure to be propagated")

    assert deleted_instance_ids == ["instance-1"]
    assert deleted_disk_ids == ["disk-1"]
