"""Verify the `--baseline-eval` flag on `eval_kokoro.py` emits a comparison block.

The fine-tune publish path gates on `gateResult.passed && comparison.beatsBaseline`;
this test pins the comparison block's shape so consumers (`push_voice_to_hf.py`,
`publish_custom_kokoro_voice.sh`) can trust the schema.
"""

from __future__ import annotations

import json
from pathlib import Path

import eval_kokoro  # type: ignore  # noqa: E402


def _write_baseline_eval(path: Path, *, utmos: float, wer: float, spksim: float, rtf: float) -> None:
    """Write a minimal baseline eval.json that eval_kokoro will consume."""
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "kokoro-eval-report",
                "voiceName": "af_bella",
                "metrics": {
                    "utmos": utmos,
                    "wer": wer,
                    "speaker_similarity": spksim,
                    "rtf": rtf,
                },
                "gates": {
                    "utmos_min": 3.8,
                    "wer_max": 0.08,
                    "speaker_similarity_min": 0.65,
                    "rtf_min": 5.0,
                },
                "gateResult": {"passed": True, "perMetric": {}},
            },
            indent=2,
        )
        + "\n"
    )


def test_synthetic_smoke_emits_comparison_block(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline.json"
    # Baseline numbers chosen so the synthetic-smoke metrics
    # (utmos=4.0, wer=0.04, speaker_similarity=0.78, rtf=12.5) clear
    # beatsBaseline: utmosDelta=+0.2 ≥ 0, werDelta=-0.01 ≤ 0,
    # speakerSimDelta=+0.1 ≥ +0.05.
    _write_baseline_eval(baseline, utmos=3.8, wer=0.05, spksim=0.68, rtf=11.0)

    run_dir = tmp_path / "run"
    run_dir.mkdir()
    eval_out = run_dir / "eval.json"
    rc = eval_kokoro.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_lora_ljspeech.yaml",
            "--baseline-eval",
            str(baseline),
            "--eval-out",
            str(eval_out),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0

    report = json.loads(eval_out.read_text())
    assert "comparison" in report
    cmp_block = report["comparison"]
    assert cmp_block["baselinePath"].endswith("baseline.json")
    assert cmp_block["baselineVoiceName"] == "af_bella"
    # 4.0 - 3.8 = 0.2 (within float epsilon).
    assert cmp_block["utmosDelta"] == 4.0 - 3.8
    assert cmp_block["werDelta"] == 0.04 - 0.05
    assert cmp_block["speakerSimDelta"] == 0.78 - 0.68
    assert cmp_block["rtfDelta"] == 12.5 - 11.0
    assert cmp_block["speakerSimBeatThreshold"] == 0.05
    assert cmp_block["beatsBaseline"] is True


def test_baseline_below_threshold_does_not_beat(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline.json"
    # Speaker similarity baseline at 0.74 → delta = 0.04 < 0.05 → !beatsBaseline.
    _write_baseline_eval(baseline, utmos=3.8, wer=0.05, spksim=0.74, rtf=11.0)

    run_dir = tmp_path / "run"
    run_dir.mkdir()
    eval_out = run_dir / "eval.json"
    rc = eval_kokoro.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_lora_ljspeech.yaml",
            "--baseline-eval",
            str(baseline),
            "--eval-out",
            str(eval_out),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0
    report = json.loads(eval_out.read_text())
    assert report["comparison"]["beatsBaseline"] is False
    # Other deltas still recorded (per-metric breakdown is required for the
    # model card).
    assert report["comparison"]["speakerSimDelta"] == 0.78 - 0.74


def test_no_baseline_flag_omits_comparison(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    eval_out = run_dir / "eval.json"
    rc = eval_kokoro.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_lora_ljspeech.yaml",
            "--eval-out",
            str(eval_out),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0
    report = json.loads(eval_out.read_text())
    assert "comparison" not in report


def test_missing_baseline_file_raises(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    eval_out = run_dir / "eval.json"
    try:
        eval_kokoro.main(
            [
                "--run-dir",
                str(run_dir),
                "--config",
                "kokoro_lora_ljspeech.yaml",
                "--baseline-eval",
                str(tmp_path / "does-not-exist.json"),
                "--eval-out",
                str(eval_out),
                "--synthetic-smoke",
            ]
        )
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("expected FileNotFoundError for missing baseline")
