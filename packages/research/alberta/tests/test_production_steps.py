# mypy: disable-error-code="untyped-decorator,unused-ignore"
"""Production-facing Step 1/2 kernel tests."""

import json
import tomllib
from pathlib import Path

import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.cli import evidence_gate_main, step1_smoke_main, step2_smoke_main
from alberta_framework.steps import (
    Step1KernelConfig,
    Step2HybridConfig,
    Step2KernelConfig,
    Step2MemoryConfig,
    Step2StrictDigitReadoutConfig,
    Step2TemporalContextConfig,
    make_step1_learner,
    make_step1_stream,
    make_step2_hybrid_learner,
    make_step2_learner,
    make_step2_memory_learner,
    make_step2_strict_digit_readout_learner,
    make_step2_temporal_context,
    make_step2_temporal_learner,
    run_step1_smoke,
    run_step2_smoke,
)


def test_step1_kernel_factory_and_smoke_are_finite() -> None:
    config = Step1KernelConfig(optimizer="autostep", normalizer="ema")
    learner = make_step1_learner(config)
    stream = make_step1_stream(config)
    state = learner.init(stream.feature_dim)

    prediction = learner.predict(state, jnp.zeros(stream.feature_dim))
    assert prediction.shape == (1,)

    result = run_step1_smoke(config, steps=16, final_window=4)
    assert result.finite
    assert result.metrics_shape == (16, 4)
    assert result.final_window_mse >= 0.0
    assert result.to_dict()["config"] == config.to_dict()


@pytest.mark.parametrize(
    "optimizer",
    [
        "lms",
        "idbd",
        "autostep",
        "autostep_gtd",
        "adagain",
        "adam",
        "rmsprop",
        "nadaline",
    ],
)
def test_step1_kernel_all_public_optimizers_smoke(optimizer: str) -> None:
    config = Step1KernelConfig(
        optimizer=optimizer,  # type: ignore[arg-type]
        normalizer="ema",
        feature_dim=8,
        num_relevant=3,
        noise_std=0.1,
    )
    result = run_step1_smoke(config, steps=12, final_window=3)
    assert result.finite
    assert result.metrics_shape == (12, 4)


def test_step1_kernel_rejects_unpublished_auto_alias() -> None:
    config = Step1KernelConfig(optimizer="auto")  # type: ignore[arg-type]
    try:
        make_step1_learner(config)
    except ValueError as exc:
        assert "unknown Step 1 optimizer" in str(exc)
    else:
        raise AssertionError("expected unpublished Auto alias to be rejected")


def test_step1_kernel_rejects_misspelled_adagain_alias() -> None:
    config = Step1KernelConfig(optimizer="adagiven")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="unknown Step 1 optimizer"):
        make_step1_learner(config)


def test_step2_kernel_factory_and_smoke_are_finite() -> None:
    config = Step2KernelConfig(feature_dim=4, n_heads=2, hidden_sizes=(8,))
    learner = make_step2_learner(config)
    state = learner.init(config.feature_dim, jr.key(0))

    prediction = learner.predict(state, jnp.zeros(config.feature_dim))
    assert prediction.shape == (2,)

    result = run_step2_smoke(config, steps=16, final_window=4)
    assert result.finite
    assert result.metrics_shape == (16, 4)
    assert result.final_window_mse >= 0.0
    assert result.learner_config["loss_normalization"] == "target_structure"
    assert result.to_dict()["config"] == config.to_dict()


def test_step2_strict_digit_readout_factory_exposes_promoted_branch() -> None:
    config = Step2StrictDigitReadoutConfig(n_heads=3, hidden_sizes=(8, 8))
    learner = make_step2_strict_digit_readout_learner(config)
    state = learner.init(feature_dim=4, key=jr.key(0))

    prediction = learner.predict(state, jnp.zeros(4))
    learner_config = learner.to_config()

    assert prediction.shape == (3,)
    assert learner_config["loss_normalization"] == "target_structure"
    assert learner_config["readout_mode"] == "two_timescale_simplex"
    assert learner_config["readout_fast_head_bounder_mode"] == "separate"
    assert config.to_dict()["hidden_sizes"] == [8, 8]


def test_step2_memory_factory_updates_fixed_budget_memory() -> None:
    config = Step2MemoryConfig(feature_dim=4, n_classes=3, slots_per_class=2)
    learner = make_step2_memory_learner(config)
    state = learner.init()

    prediction = learner.predict(state, jnp.zeros(config.feature_dim))
    assert prediction.shape == (3,)

    target = jnp.asarray([0.0, 1.0, 0.0], dtype=jnp.float32)
    result = learner.update(state, jnp.ones(config.feature_dim), target)
    assert int(result.state.step_count) == 1
    assert int(jnp.sum(result.state.counts > 0.0)) == 1
    assert learner.config.to_config()["slots_per_class"] == 2
    assert config.to_dict()["n_classes"] == 3


def test_step2_hybrid_factory_updates_upgd_and_memory() -> None:
    config = Step2HybridConfig(
        feature_dim=4,
        n_heads=3,
        hidden_sizes=(8,),
        upgd_head_repetition_multiplier=2.0,
        upgd_head_repetition_warmup_steps=4,
        target_trace_blend_scale=0.2,
    )
    learner = make_step2_hybrid_learner(config)
    state = learner.init(jr.key(0))

    prediction = learner.predict(state, jnp.zeros(config.feature_dim))
    assert prediction.shape == (3,)

    target = jnp.asarray([0.0, 1.0, 0.0], dtype=jnp.float32)
    result = learner.update(state, jnp.ones(config.feature_dim), target)
    assert int(result.state.upgd_state.step_count) == 1
    assert int(result.state.memory_state.step_count) == 1
    assert int(jnp.sum(result.state.memory_state.counts > 0.0)) == 1
    assert learner.config.to_dict()["slots_per_class"] == config.slots_per_class
    upgd_config = learner.upgd.to_config()
    assert upgd_config["head_repetition_multiplier"] == 2.0
    assert upgd_config["head_repetition_warmup_steps"] == 4
    assert learner.config.target_trace_blend_scale == 0.2


def test_step2_hybrid_default_is_promoted_trace_variant() -> None:
    config = Step2HybridConfig()
    learner = make_step2_hybrid_learner(config)

    assert config.initial_memory_logit == 0.0
    assert config.target_trace_blend_scale == 0.8
    assert config.target_trace_pressure_threshold == 0.5
    assert learner.config.initial_memory_logit == 0.0
    assert learner.config.target_trace_blend_scale == 0.8
    assert learner.config.target_trace_pressure_threshold == 0.5


def test_step2_temporal_context_factory_matches_learner_input() -> None:
    config = Step2TemporalContextConfig(feature_dim=4, n_heads=2, hidden_sizes=(8,))
    featurizer = make_step2_temporal_context(config)
    learner = make_step2_temporal_learner(config)
    context_state = featurizer.init()
    context_state, features = featurizer.step(
        context_state,
        jnp.ones(config.feature_dim),
    )
    learner_state = learner.init(features.shape[0], jr.key(0))

    prediction = learner.predict(learner_state, features)

    assert prediction.shape == (2,)
    assert featurizer.config.include_phase_products
    assert not featurizer.config.include_ema
    assert not featurizer.config.include_delta
    assert config.to_dict()["periods"] == list(config.periods)


def test_step_facade_configs_json_roundtrip() -> None:
    configs = [
        Step1KernelConfig(),
        Step2KernelConfig(),
        Step2StrictDigitReadoutConfig(),
        Step2MemoryConfig(),
        Step2HybridConfig(),
        Step2TemporalContextConfig(),
    ]

    for config in configs:
        payload = json.loads(json.dumps(config.to_dict()))
        rebuilt = type(config).from_dict(payload)
        assert rebuilt == config


def test_cli_smoke_entrypoints_return_success(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert step1_smoke_main(["--steps", "8", "--final-window", "2"]) == 0
    assert '"finite": true' in capsys.readouterr().out

    assert step2_smoke_main(["--steps", "8", "--final-window", "2"]) == 0
    assert '"finite": true' in capsys.readouterr().out


def test_documented_cli_scripts_are_packaged() -> None:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    payload = tomllib.loads(pyproject.read_text())
    scripts = payload["project"]["scripts"]

    assert scripts["alberta-step1-smoke"] == "alberta_framework.cli:step1_smoke_main"
    assert scripts["alberta-step2-smoke"] == "alberta_framework.cli:step2_smoke_main"
    assert scripts["alberta-evidence-gate"] == "alberta_framework.cli:evidence_gate_main"


def test_evidence_gate_reports_present_artifacts(
    capsys: pytest.CaptureFixture[str],
) -> None:
    step1_dir = Path(__file__).resolve().parents[1] / "outputs" / "step1_canonical"
    required = [
        step1_dir / "multi_baseline_results.json",
        step1_dir / "normalization_ablation_results.json",
        step1_dir / "robustness_study_results.json",
    ]
    if not all(p.exists() for p in required):
        pytest.skip("Step 1 canonical outputs not present — run Step 1 experiments first.")
    status = evidence_gate_main(["--step", "1"])
    output = capsys.readouterr().out
    assert status == 0
    assert '"passed": true' in output


def test_step2_evidence_gate_requires_formal_closure_artifacts(
    capsys: pytest.CaptureFixture[str],
) -> None:
    status = evidence_gate_main(["--step", "2"])
    output = capsys.readouterr().out

    assert status == 0
    assert '"required_count": 10' in output
    assert "step2_upgd_recursive_feature_discovery_theory.md" not in output
    assert "step2_associative_memory_theory.md" not in output
    assert "step2_distribution_free_limits.md" not in output
    assert "step2_compositional_no_regret.md" not in output
    assert "step2_completion_criteria.md" not in output
    assert '"passed": true' in output
