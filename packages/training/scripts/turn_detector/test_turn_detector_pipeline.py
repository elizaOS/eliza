"""Smoke tests for the turn-detector fine-tune scaffold.

These tests exercise the runnable surface of `finetune_turn_detector.py`
and `eval_turn_detector.py` without invoking real training or ONNX
inference:

  - Config IO (`load_config`) round-trips the canonical YAML/JSON shape.
  - `default_revision_for_tier` matches the runtime resolver.
  - `stage_data` writes a deterministic manifest.
  - `compute_f1` is correct on a handful of canonical inputs.
  - `is_gate_met` is wired to the same thresholds the runtime validator
    exports (``TURN_DETECTOR_F1_THRESHOLD`` / ``..._MEAN_LATENCY_MS_LIMIT``).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.turn_detector import (
    eval_turn_detector as evald,
)
from scripts.turn_detector import finetune_turn_detector as fld


# ---------------------------------------------------------------------------
# default_revision_for_tier
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("tier", "expected"),
    [
        ("0_8b", "v1.2.2-en"),
        ("2b", "v1.2.2-en"),
        ("eliza-1-0_8b", "v1.2.2-en"),
        ("eliza-1-2b", "v1.2.2-en"),
        ("4b", "v0.4.1-intl"),
        ("9b", "v0.4.1-intl"),
        ("27b", "v0.4.1-intl"),
        ("27b-256k", "v0.4.1-intl"),
        ("eliza-1-4b", "v0.4.1-intl"),
    ],
)
def test_default_revision_for_tier(tier: str, expected: str) -> None:
    assert fld.default_revision_for_tier(tier) == expected


# ---------------------------------------------------------------------------
# load_config
# ---------------------------------------------------------------------------


def _write_config(tmp_path: Path, **overrides: object) -> Path:
    base: dict[str, object] = {
        "tier": "4b",
        "teacher_repo": "livekit/turn-detector",
        "teacher_revision": "v0.4.1-intl",
        "lora_rank": 16,
        "optimizer": "apollo",
        "epochs": 3,
        "learning_rate": 1e-4,
        "train_data": [],
        "eval_data": [],
    }
    base.update(overrides)
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(base), encoding="utf-8")
    return config_path


def test_load_config_round_trip(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path)
    cfg = fld.load_config(config_path)
    assert cfg.tier == "4b"
    assert cfg.teacher_repo == "livekit/turn-detector"
    assert cfg.teacher_revision == "v0.4.1-intl"
    assert cfg.lora_rank == 16
    assert cfg.optimizer == "apollo"
    assert cfg.epochs == 3
    assert cfg.learning_rate == pytest.approx(1e-4)
    assert cfg.f1_gate == fld.F1_GATE
    assert cfg.mean_latency_ms_gate == fld.MEAN_LATENCY_MS_GATE


def test_load_config_rejects_bad_optimizer(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path, optimizer="lion")
    with pytest.raises(ValueError, match="optimizer must be"):
        fld.load_config(config_path)


def test_load_config_rejects_missing_keys(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"tier": "4b"}), encoding="utf-8")
    with pytest.raises(ValueError, match="config missing keys"):
        fld.load_config(config_path)


# ---------------------------------------------------------------------------
# stage_data
# ---------------------------------------------------------------------------


def test_stage_data_writes_manifest(tmp_path: Path) -> None:
    train = tmp_path / "train.jsonl"
    train.write_text(
        json.dumps({"transcript": "hello.", "label": 1}) + "\n",
        encoding="utf-8",
    )
    evalp = tmp_path / "eval.jsonl"
    evalp.write_text(
        json.dumps({"transcript": "yes.", "label": 1}) + "\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"
    manifest = fld.stage_data(
        train_paths=[train], eval_paths=[evalp], out_dir=out
    )
    assert (out / "stage-manifest.json").is_file()
    assert manifest["train"][0]["path"] == str(train)
    assert manifest["eval"][0]["path"] == str(evalp)
    assert manifest["schemaVersion"] == 1


def test_stage_data_rejects_missing_paths(tmp_path: Path) -> None:
    out = tmp_path / "out"
    with pytest.raises(FileNotFoundError):
        fld.stage_data(
            train_paths=[tmp_path / "nope.jsonl"],
            eval_paths=[],
            out_dir=out,
        )


# ---------------------------------------------------------------------------
# eval — F1 + gate
# ---------------------------------------------------------------------------


def test_compute_f1_perfect_score() -> None:
    preds = [1, 0, 1, 0]
    golds = [1, 0, 1, 0]
    assert evald.compute_f1(preds, golds) == 1.0


def test_compute_f1_all_false_positive() -> None:
    preds = [1, 1, 1, 1]
    golds = [0, 0, 0, 0]
    assert evald.compute_f1(preds, golds) == 0.0


def test_compute_f1_collapsed_to_negative() -> None:
    preds = [0, 0, 0, 0]
    golds = [1, 1, 1, 1]
    assert evald.compute_f1(preds, golds) == 0.0


def test_compute_f1_partial() -> None:
    preds = [1, 1, 0, 0]
    golds = [1, 0, 1, 0]
    # TP=1 FP=1 FN=1 → P=0.5 R=0.5 F1=0.5
    assert evald.compute_f1(preds, golds) == pytest.approx(0.5)


def test_is_gate_met_passes_when_thresholds_hold() -> None:
    assert evald.is_gate_met(f1=0.90, mean_latency_ms=20.0) is True
    # On-threshold ⇒ pass.
    assert evald.is_gate_met(f1=evald.F1_GATE, mean_latency_ms=20.0) is True
    assert (
        evald.is_gate_met(
            f1=0.90, mean_latency_ms=evald.MEAN_LATENCY_MS_GATE
        )
        is True
    )


def test_is_gate_met_fails_on_low_f1() -> None:
    assert (
        evald.is_gate_met(f1=evald.F1_GATE - 0.01, mean_latency_ms=20.0)
        is False
    )


def test_is_gate_met_fails_on_high_latency() -> None:
    assert (
        evald.is_gate_met(
            f1=0.95, mean_latency_ms=evald.MEAN_LATENCY_MS_GATE + 0.5
        )
        is False
    )


def test_gate_report_shape() -> None:
    r = evald.gate_report(f1=0.91, mean_latency_ms=22.5)
    assert set(r.keys()) == {"f1", "meanLatencyMs", "passed"}
    assert r["f1"] == 0.91
    assert r["meanLatencyMs"] == 22.5
    assert r["passed"] is True


def test_load_records_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "set.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"transcript": "hello.", "label": 1}),
                json.dumps({"transcript": "i need a", "label": 0}),
                "",  # blank line tolerated
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    out = evald.load_records(path)
    assert len(out) == 2
    assert out[0].transcript == "hello."
    assert out[0].label == 1
    assert out[1].label == 0


def test_load_records_rejects_bad_label(tmp_path: Path) -> None:
    path = tmp_path / "set.jsonl"
    path.write_text(
        json.dumps({"transcript": "x", "label": 2}) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="label must be 0 or 1"):
        evald.load_records(path)


# ---------------------------------------------------------------------------
# Smoke driver
# ---------------------------------------------------------------------------


def test_main_smoke_writes_resolved_config(tmp_path: Path) -> None:
    train = tmp_path / "train.jsonl"
    train.write_text(
        json.dumps({"transcript": "x", "label": 1}) + "\n",
        encoding="utf-8",
    )
    evalp = tmp_path / "eval.jsonl"
    evalp.write_text(
        json.dumps({"transcript": "x", "label": 0}) + "\n",
        encoding="utf-8",
    )
    config_path = _write_config(
        tmp_path,
        train_data=[str(train)],
        eval_data=[str(evalp)],
    )
    out = tmp_path / "out"
    rc = fld.main(
        [
            "--config",
            str(config_path),
            "--out",
            str(out),
            "--smoke",
        ]
    )
    assert rc == 0
    resolved = json.loads(
        (out / "resolved-config.json").read_text(encoding="utf-8")
    )
    assert resolved["tier"] == "4b"
    assert resolved["teacher_revision"] == "v0.4.1-intl"
    assert (out / "data" / "stage-manifest.json").is_file()
