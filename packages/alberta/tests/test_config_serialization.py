"""Tests for learner/optimizer/bounder/normalizer config serialization."""

import jax.numpy as jnp
import pytest

from alberta_framework import (
    IDBD,
    LMS,
    AdaptiveObGDBounding,
    AGCBounding,
    Autostep,
    AutostepGTDLambda,
    EMANormalizer,
    MLPLearner,
    MultiHeadMLPLearner,
    ObGD,
    ObGDBounding,
    StreamingBatchNormalizer,
    WelfordNormalizer,
    bounder_from_config,
    normalizer_from_config,
    optimizer_from_config,
)

# =============================================================================
# Optimizer round-trip
# =============================================================================


class TestOptimizerConfig:
    """Round-trip to_config/from_config for optimizers."""

    def test_lms_round_trip(self):
        opt = LMS(step_size=0.05)
        config = opt.to_config()
        assert config["type"] == "LMS"
        assert config["step_size"] == 0.05

        restored = optimizer_from_config(config)
        assert isinstance(restored, LMS)
        assert restored._step_size == 0.05

    def test_idbd_round_trip(self):
        opt = IDBD(initial_step_size=0.02, meta_step_size=0.03)
        config = opt.to_config()
        assert config["type"] == "IDBD"

        restored = optimizer_from_config(config)
        assert isinstance(restored, IDBD)
        assert restored._initial_step_size == 0.02
        assert restored._meta_step_size == 0.03

    def test_autostep_round_trip(self):
        opt = Autostep(initial_step_size=0.01, meta_step_size=0.02, tau=5000.0)
        config = opt.to_config()
        assert config["type"] == "Autostep"

        restored = optimizer_from_config(config)
        assert isinstance(restored, Autostep)
        assert restored._initial_step_size == 0.01
        assert restored._tau == 5000.0

    def test_autostep_gtd_lambda_round_trip(self):
        opt = AutostepGTDLambda(
            initial_step_size=0.01,
            meta_step_size=0.02,
            tau=5000.0,
            trace_decay=0.3,
        )
        config = opt.to_config()
        assert config["type"] == "AutostepGTDLambda"

        restored = optimizer_from_config(config)
        assert isinstance(restored, AutostepGTDLambda)
        assert restored._initial_step_size == 0.01
        assert restored._trace_decay == 0.3

    def test_obgd_round_trip(self):
        opt = ObGD(step_size=0.5, kappa=3.0, gamma=0.99, lamda=0.9)
        config = opt.to_config()
        assert config["type"] == "ObGD"

        restored = optimizer_from_config(config)
        assert isinstance(restored, ObGD)
        assert restored._step_size == 0.5
        assert restored._kappa == 3.0

    def test_unknown_optimizer_raises(self):
        with pytest.raises(ValueError, match="Unknown optimizer"):
            optimizer_from_config({"type": "UnknownOpt"})


# =============================================================================
# Bounder round-trip
# =============================================================================


class TestBounderConfig:
    """Round-trip to_config/from_config for bounders."""

    def test_obgd_bounding_round_trip(self):
        b = ObGDBounding(kappa=3.0)
        config = b.to_config()
        assert config["type"] == "ObGDBounding"

        restored = bounder_from_config(config)
        assert isinstance(restored, ObGDBounding)
        assert restored._kappa == 3.0

    def test_adaptive_obgd_bounding_round_trip(self):
        b = AdaptiveObGDBounding(kappa=3.0, eps=1e-6)
        config = b.to_config()
        assert config["type"] == "AdaptiveObGDBounding"
        assert config["kappa"] == 3.0
        assert config["eps"] == 1e-6
        restored = bounder_from_config(config)
        assert isinstance(restored, AdaptiveObGDBounding)
        assert restored._kappa == 3.0
        assert restored._eps == 1e-6

    def test_agc_bounding_round_trip(self):
        b = AGCBounding(clip_factor=0.02, eps=1e-4)
        config = b.to_config()
        assert config["type"] == "AGCBounding"

        restored = bounder_from_config(config)
        assert isinstance(restored, AGCBounding)
        assert restored._clip_factor == 0.02
        assert restored._eps == 1e-4

    def test_adaptive_obgd_reduces_large_steps(self):
        """AdaptiveObGDBounding should scale down large per-weight steps."""
        b = AdaptiveObGDBounding(kappa=1.0, eps=1e-8)
        steps = (jnp.ones(10) * 10.0, jnp.ones(5) * 5.0)
        error = jnp.array(2.0)
        bounded, scale = b.bound(steps, error, steps)
        total_bounded = float(sum(jnp.sum(jnp.abs(s)) for s in bounded))
        total_original = float(sum(jnp.sum(jnp.abs(s)) for s in steps))
        assert total_bounded < total_original

    def test_adaptive_obgd_smaller_than_obgd(self):
        """Per-weight RMS stage should further reduce steps vs plain ObGDBounding."""
        steps = (jnp.array([1.0, 100.0, 0.1]),)
        error = jnp.array(1.0)
        plain = ObGDBounding(kappa=1.0)
        adaptive = AdaptiveObGDBounding(kappa=1.0)
        _, plain_scale = plain.bound(steps, error, steps)
        bounded_adaptive, _ = adaptive.bound(steps, error, steps)
        total_adaptive = float(jnp.sum(jnp.abs(bounded_adaptive[0])))
        plain_bounded_total = float(plain_scale * jnp.sum(jnp.abs(steps[0])))
        assert total_adaptive < plain_bounded_total or total_adaptive == pytest.approx(
            plain_bounded_total, rel=0.1
        )

    def test_unknown_bounder_raises(self):
        with pytest.raises(ValueError, match="Unknown bounder"):
            bounder_from_config({"type": "UnknownBound"})


# =============================================================================
# Normalizer round-trip
# =============================================================================


class TestNormalizerConfig:
    """Round-trip to_config/from_config for normalizers."""

    def test_ema_round_trip(self):
        n = EMANormalizer(decay=0.95, epsilon=1e-6)
        config = n.to_config()
        assert config["type"] == "EMANormalizer"

        restored = normalizer_from_config(config)
        assert isinstance(restored, EMANormalizer)
        assert restored._decay == 0.95
        assert restored._epsilon == 1e-6

    def test_welford_round_trip(self):
        n = WelfordNormalizer(epsilon=1e-7)
        config = n.to_config()
        assert config["type"] == "WelfordNormalizer"

        restored = normalizer_from_config(config)
        assert isinstance(restored, WelfordNormalizer)
        assert restored._epsilon == 1e-7

    def test_streaming_batch_round_trip(self):
        n = StreamingBatchNormalizer(momentum=0.97, epsilon=1e-5)
        config = n.to_config()
        assert config["type"] == "StreamingBatchNormalizer"

        restored = normalizer_from_config(config)
        assert isinstance(restored, StreamingBatchNormalizer)
        assert restored._momentum == 0.97
        assert restored._epsilon == 1e-5

    def test_unknown_normalizer_raises(self):
        with pytest.raises(ValueError, match="Unknown normalizer"):
            normalizer_from_config({"type": "UnknownNorm"})


# =============================================================================
# MLPLearner round-trip
# =============================================================================


class TestMLPLearnerConfig:
    """Round-trip to_config/from_config for MLPLearner."""

    def test_default_lms(self):
        learner = MLPLearner(hidden_sizes=(64, 32), step_size=0.5)
        config = learner.to_config()
        assert config["type"] == "MLPLearner"
        assert config["hidden_sizes"] == [64, 32]
        assert config["optimizer"]["type"] == "LMS"
        assert config["optimizer"]["step_size"] == 0.5

        restored = MLPLearner.from_config(config)
        assert isinstance(restored, MLPLearner)
        assert restored._hidden_sizes == (64, 32)
        assert isinstance(restored._optimizer, LMS)

    def test_autostep_with_bounder_normalizer(self):
        learner = MLPLearner(
            hidden_sizes=(128, 128),
            optimizer=Autostep(initial_step_size=0.01, tau=5000.0),
            bounder=ObGDBounding(kappa=3.0),
            normalizer=EMANormalizer(decay=0.95),
            sparsity=0.8,
            gamma=0.99,
            lamda=0.9,
        )
        config = learner.to_config()

        restored = MLPLearner.from_config(config)
        assert isinstance(restored._optimizer, Autostep)
        assert isinstance(restored._bounder, ObGDBounding)
        assert isinstance(restored._normalizer, EMANormalizer)
        assert restored._sparsity == 0.8
        assert restored._gamma == 0.99

    def test_hybrid_optimizer(self):
        learner = MLPLearner(
            hidden_sizes=(64,),
            step_size=1.0,
            head_optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
        )
        config = learner.to_config()
        assert config["head_optimizer"] is not None
        assert config["head_optimizer"]["type"] == "Autostep"

        restored = MLPLearner.from_config(config)
        assert isinstance(restored._head_optimizer, Autostep)

    def test_none_optional_fields(self):
        learner = MLPLearner(hidden_sizes=(32,), step_size=1.0)
        config = learner.to_config()
        assert config["bounder"] is None
        assert config["normalizer"] is None
        assert config["head_optimizer"] is None

        restored = MLPLearner.from_config(config)
        assert restored._bounder is None
        assert restored._normalizer is None
        assert restored._head_optimizer is None

    def test_round_trip_preserves_all_params(self):
        learner = MLPLearner(
            hidden_sizes=(128, 64),
            optimizer=IDBD(initial_step_size=0.02, meta_step_size=0.03),
            bounder=AGCBounding(clip_factor=0.02),
            normalizer=WelfordNormalizer(epsilon=1e-7),
            sparsity=0.5,
            leaky_relu_slope=0.02,
            use_layer_norm=False,
            gamma=0.5,
            lamda=0.3,
        )
        config = learner.to_config()
        restored = MLPLearner.from_config(config)

        assert restored._hidden_sizes == (128, 64)
        assert restored._sparsity == 0.5
        assert restored._leaky_relu_slope == 0.02
        assert restored._use_layer_norm is False
        assert restored._gamma == 0.5
        assert restored._lamda == 0.3


# =============================================================================
# MultiHeadMLPLearner round-trip
# =============================================================================


class TestMultiHeadMLPLearnerConfig:
    """Round-trip to_config/from_config for MultiHeadMLPLearner."""

    def test_basic(self):
        learner = MultiHeadMLPLearner(
            n_heads=5,
            hidden_sizes=(64, 64),
            step_size=1.0,
        )
        config = learner.to_config()
        assert config["type"] == "MultiHeadMLPLearner"
        assert config["n_heads"] == 5
        assert config["hidden_sizes"] == [64, 64]

        restored = MultiHeadMLPLearner.from_config(config)
        assert isinstance(restored, MultiHeadMLPLearner)
        assert restored._n_heads == 5
        assert restored._hidden_sizes == (64, 64)

    def test_full_config(self):
        learner = MultiHeadMLPLearner(
            n_heads=5,
            hidden_sizes=(64, 64),
            optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
            normalizer=EMANormalizer(decay=0.99),
            head_optimizer=LMS(step_size=0.1),
            sparsity=0.9,
            use_layer_norm=True,
            gamma=0.0,
            lamda=0.9,
        )
        config = learner.to_config()

        restored = MultiHeadMLPLearner.from_config(config)
        assert isinstance(restored._optimizer, Autostep)
        assert isinstance(restored._bounder, ObGDBounding)
        assert isinstance(restored._normalizer, EMANormalizer)
        assert isinstance(restored._head_optimizer, LMS)
        assert restored._n_heads == 5
        assert restored._sparsity == 0.9

    def test_linear_baseline(self):
        """hidden_sizes=() should round-trip."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(), step_size=1.0,
        )
        config = learner.to_config()
        assert config["hidden_sizes"] == []

        restored = MultiHeadMLPLearner.from_config(config)
        assert restored._hidden_sizes == ()

    def test_config_matches_rlsecd_schema(self):
        """Config dict should match the documented schema from the plan."""
        learner = MultiHeadMLPLearner(
            n_heads=5,
            hidden_sizes=(64, 64),
            optimizer=Autostep(initial_step_size=0.01, meta_step_size=0.01, tau=10000.0),
            bounder=ObGDBounding(kappa=2.0),
            normalizer=EMANormalizer(decay=0.99),
            sparsity=0.9,
            use_layer_norm=True,
            gamma=0.0,
            lamda=0.0,
        )
        config = learner.to_config()

        # Verify all expected keys present
        assert config["type"] == "MultiHeadMLPLearner"
        assert config["n_heads"] == 5
        assert config["hidden_sizes"] == [64, 64]
        assert config["optimizer"]["type"] == "Autostep"
        assert config["bounder"]["type"] == "ObGDBounding"
        assert config["normalizer"]["type"] == "EMANormalizer"
        assert config["head_optimizer"] is None
        assert config["sparsity"] == 0.9
        assert config["use_layer_norm"] is True
