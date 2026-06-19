from __future__ import annotations

from pathlib import Path

DOC = Path(__file__).resolve().parents[2] / "docs" / "asimov-1.md"


def test_asimov_docs_use_current_sim_gate_interface() -> None:
    text = DOC.read_text(encoding="utf-8")

    assert "sim_validation_gate.py --profile asimov-1 --steps" not in text
    assert "--require-asimov-model-provenance" in text


def test_asimov_docs_name_required_production_evidence() -> None:
    text = DOC.read_text(encoding="utf-8")
    normalized = " ".join(text.split())

    assert "uv run eliza-robot-train" in text
    assert "checkpoints/asimov_1_alberta_full" in text
    assert "regime=\"alberta_streaming\"" in text
    assert "a tiny Alberta checkpoint through the default trainer" in normalized
    assert "Smoke checkpoints from `rl/text_conditioned/train.py --smoke`" in text
    assert "validate_asimov1_full_training_run.py" in text
    assert "validate_asimov1_production_checkpoint.py --require-inference-check" in text
    assert "validate_asimov1_real_hardware_evidence.py" in text
    assert "validate_asimov1_real_agent_run.py" in text
    assert "final completion gate accepts Alberta checkpoints" in text
