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


def test_dry_run_merges_all_quantization_recipe_sidecars(
    tmp_path: Path,
    capsys,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    (checkpoint / "polarquant_config.json").write_text(
        json.dumps(
            {
                "source_model": "Qwen/Qwen3.5-4B-Base",
                "recipe": {"bits": 4, "block_size": 128, "use_qjl": True},
                "kernel_manifest": kernel_manifest_fragment("polarquant"),
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "qjl_config.json").write_text(
        json.dumps(
            {
                "source_model": "Qwen/Qwen3.5-4B-Base",
                "projection_dim_per_head": 256,
                "kernel_manifest": kernel_manifest_fragment("qjl"),
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "turboquant.json").write_text(
        json.dumps(
            {
                "source_model": "Qwen/Qwen3.5-4B-Base",
                "nbits": 4,
                "kernel_manifest": kernel_manifest_fragment("turboquant"),
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "fused_turboquant.json").write_text(
        json.dumps(
            {
                "source_model": "Qwen/Qwen3.5-4B-Base",
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
    assert ext["sidecar_inputs"]["fused_turboquant"].endswith(
        "fused_turboquant.json"
    )
    assert ext["fused_turboquant"]["bits"] == 4
    assert set(ext["recipeManifest"]) == {
        "polar_q4",
        "qjl1_256",
        "turbo3",
        "turbo4",
        "turbo3_tcq",
    }
