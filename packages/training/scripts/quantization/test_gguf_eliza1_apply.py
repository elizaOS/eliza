from __future__ import annotations

import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.quantization.gguf_eliza1_apply import main  # noqa: E402
from scripts.quantization._kernel_manifest import kernel_manifest_fragment  # noqa: E402


def test_q4_polar_refuses_missing_polar_sidecar_by_default(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()

    rc = main(
        [
            "--checkpoint",
            str(checkpoint),
            "--output",
            str(tmp_path / "model.gguf"),
            "--outtype",
            "q4_polar",
            "--dry-run",
        ]
    )

    assert rc == 2


def test_q4_polar_fallback_requires_explicit_escape_hatch(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()

    rc = main(
        [
            "--checkpoint",
            str(checkpoint),
            "--output",
            str(tmp_path / "model.gguf"),
            "--outtype",
            "q4_polar",
            "--allow-unoptimized-fallback",
            "--dry-run",
        ]
    )

    assert rc == 0


def test_stock_outtype_dry_run_does_not_cite_sidecars_as_recipe_provenance(
    tmp_path: Path,
    capsys,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    (checkpoint / "polarquant_config.json").write_text(
        json.dumps(
            {
                "source_model": "google/gemma-4-E4B-Base",
                "recipe": {"bits": 4, "block_size": 128, "use_qjl": True},
                "kernel_manifest": kernel_manifest_fragment("polarquant"),
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "qjl_config.json").write_text(
        json.dumps(
            {
                "source_model": "google/gemma-4-E4B-Base",
                "projection_dim_per_head": 256,
                "kernel_manifest": kernel_manifest_fragment("qjl"),
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "turboquant.json").write_text(
        json.dumps(
            {
                "source_model": "google/gemma-4-E4B-Base",
                "nbits": 4,
                "kernel_manifest": kernel_manifest_fragment("turboquant"),
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "fused_turboquant.json").write_text(
        json.dumps(
            {
                "source_model": "google/gemma-4-E4B-Base",
                "recipe": {"bits": 4, "compress_v": True, "verify": True},
                "head_dim": 256,
                "kernel_manifest": kernel_manifest_fragment("fused-turboquant"),
            }
        ),
        encoding="utf-8",
    )

    rc = main(
        [
            "--checkpoint",
            str(checkpoint),
            "--output",
            str(tmp_path / "model.gguf"),
            "--outtype",
            "q8_0",
            "--dry-run",
        ]
    )

    assert rc == 0
    plan = json.loads(capsys.readouterr().out)
    ext = plan["ext_metadata"]
    assert ext["speculative"] == {
        "preferred": "draft-mtp",
        "preserveMtp": True,
        "externalDrafterRequired": False,
    }
    assert ext["sidecar_inputs"]["fused_turboquant"].endswith(
        "fused_turboquant.json"
    )
    assert ext["fused_turboquant"]["bits"] == 4
    assert ext["polarquant"] == {
        "bits": 4,
        "block_size": 128,
        "use_qjl": True,
        "n_layers_quantized": None,
        "average_block_mse": None,
    }
    assert ext["qjl"]["projection_dim_per_head"] == 256
    assert ext["qjl"]["key_bits"] == 1
    assert ext["qjl"]["value_bits"] == 4
    assert ext["turboquant"]["nbits"] == 4
    assert "recipeManifest" not in ext
    assert ext["recipeStatus"]["polarquant"] == {
        "sidecarPresent": True,
        "manifestCited": False,
        "reason": (
            "PolarQuant sidecars are not cited unless the produced GGUF "
            "actually uses q4_polar tensor blocks"
        ),
    }
    assert ext["recipeStatus"]["qjl"]["sidecarPresent"] is True
    assert ext["recipeStatus"]["qjl"]["manifestCited"] is False
    assert ext["recipeStatus"]["turboquant"]["sidecarPresent"] is True
    assert ext["recipeStatus"]["turboquant"]["manifestCited"] is False
    assert ext["recipeStatus"]["fused_turboquant"]["sidecarPresent"] is True
    assert ext["recipeStatus"]["fused_turboquant"]["manifestCited"] is False


def test_q4_polar_dry_run_cites_only_actual_weight_recipe(
    tmp_path: Path,
    capsys,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    fake_llama = tmp_path / "llama.cpp"
    fake_llama.mkdir()
    (fake_llama / "convert_hf_to_gguf.py").write_text(
        "# supports Q4_POLAR\n", encoding="utf-8"
    )
    (checkpoint / "polarquant_config.json").write_text(
        json.dumps(
            {
                "source_model": "google/gemma-4-E4B-Base",
                "recipe": {"bits": 4, "block_size": 128, "use_qjl": True},
                "kernel_manifest": kernel_manifest_fragment("polarquant"),
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "qjl_config.json").write_text(
        json.dumps(
            {
                "source_model": "google/gemma-4-E4B-Base",
                "projection_dim_per_head": 256,
                "kernel_manifest": kernel_manifest_fragment("qjl"),
            }
        ),
        encoding="utf-8",
    )

    rc = main(
        [
            "--checkpoint",
            str(checkpoint),
            "--output",
            str(tmp_path / "model.gguf"),
            "--outtype",
            "q4_polar",
            "--llama-cpp-dir",
            str(fake_llama),
            "--allow-unoptimized-fallback",
            "--dry-run",
        ]
    )

    assert rc == 0
    plan = json.loads(capsys.readouterr().out)
    ext = plan["ext_metadata"]
    assert set(ext["recipeManifest"]) == {"polar_q4"}
    assert ext["recipeStatus"]["polarquant"]["manifestCited"] is True
    assert ext["recipeStatus"]["qjl"]["sidecarPresent"] is True
    assert ext["recipeStatus"]["qjl"]["manifestCited"] is False


def test_dry_run_can_request_trunk_only_without_mtp(
    tmp_path: Path,
    capsys,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()

    rc = main(
        [
            "--checkpoint",
            str(checkpoint),
            "--output",
            str(tmp_path / "model.gguf"),
            "--outtype",
            "q8_0",
            "--drop-mtp",
            "--dry-run",
        ]
    )

    assert rc == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan["ext_metadata"]["speculative"] == {
        "preferred": "external-drafter",
        "preserveMtp": False,
        "externalDrafterRequired": True,
    }
