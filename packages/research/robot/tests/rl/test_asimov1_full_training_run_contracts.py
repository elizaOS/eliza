from __future__ import annotations

from scripts.validate_asimov1_full_training_run import (
    _expected_production_min_steps,
    _production_step_contract,
)


def _production_step(*, argv_min_steps: str, parsed_min_steps: int):
    return {
        "argv": [
            "python",
            "scripts/validate_asimov1_production_checkpoint.py",
            "job",
            "--min-steps",
            argv_min_steps,
            "--require-inference-check",
        ],
        "passed": True,
        "parsed": {
            "ok": True,
            "min_steps": parsed_min_steps,
            "checks": {"inference_check": True},
        },
    }


def test_full_training_run_contract_requires_expected_production_min_steps() -> None:
    step = _production_step(argv_min_steps="1", parsed_min_steps=1)

    assert (
        _production_step_contract([step], expected_min_steps=150_000_000)
        is False
    )


def test_full_training_run_contract_accepts_matching_production_min_steps() -> None:
    step = _production_step(argv_min_steps="150000000", parsed_min_steps=150_000_000)

    assert (
        _production_step_contract([step], expected_min_steps=150_000_000)
        is True
    )


def test_expected_production_min_steps_rejects_boolean_budget() -> None:
    assert _expected_production_min_steps({"ppo": {"num_timesteps": True}}) is None

