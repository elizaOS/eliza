"""Tests for GVF types: DemonType, GVFSpec, HordeSpec, create_horde_spec."""

import chex
import jax.numpy as jnp

from alberta_framework import (
    DemonType,
    GVFSpec,
    HordeSpec,
    create_horde_spec,
)


class TestDemonType:
    """Tests for DemonType enum."""

    def test_prediction_value(self):
        assert DemonType.PREDICTION.value == "prediction"

    def test_control_value(self):
        assert DemonType.CONTROL.value == "control"

    def test_from_string(self):
        assert DemonType("prediction") is DemonType.PREDICTION
        assert DemonType("control") is DemonType.CONTROL


class TestGVFSpec:
    """Tests for GVFSpec construction and serialization."""

    def test_basic_construction(self):
        spec = GVFSpec(
            name="is_malicious",
            demon_type=DemonType.PREDICTION,
            gamma=0.0,
            lamda=0.0,
            cumulant_index=0,
        )
        assert spec.name == "is_malicious"
        assert spec.demon_type is DemonType.PREDICTION
        assert spec.gamma == 0.0
        assert spec.lamda == 0.0
        assert spec.cumulant_index == 0
        assert spec.terminal_reward == 0.0  # default

    def test_temporal_demon(self):
        spec = GVFSpec(
            name="future_attacks",
            demon_type=DemonType.PREDICTION,
            gamma=0.9,
            lamda=0.8,
            cumulant_index=1,
            terminal_reward=0.0,
        )
        assert spec.gamma == 0.9
        assert spec.lamda == 0.8

    def test_config_roundtrip(self):
        original = GVFSpec(
            name="attack_type",
            demon_type=DemonType.PREDICTION,
            gamma=0.95,
            lamda=0.5,
            cumulant_index=2,
            terminal_reward=1.0,
        )
        config = original.to_config()
        restored = GVFSpec.from_config(config)

        assert restored.name == original.name
        assert restored.demon_type is original.demon_type
        assert restored.gamma == original.gamma
        assert restored.lamda == original.lamda
        assert restored.cumulant_index == original.cumulant_index
        assert restored.terminal_reward == original.terminal_reward

    def test_config_format(self):
        spec = GVFSpec(
            name="test",
            demon_type=DemonType.CONTROL,
            gamma=0.99,
            lamda=0.0,
            cumulant_index=-1,
        )
        config = spec.to_config()
        assert config["demon_type"] == "control"
        assert config["name"] == "test"
        assert config["gamma"] == 0.99


class TestHordeSpec:
    """Tests for HordeSpec construction and serialization."""

    def test_create_horde_spec(self):
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
            GVFSpec(
                name="d1", demon_type=DemonType.PREDICTION, gamma=0.9, lamda=0.8, cumulant_index=1
            ),
            GVFSpec(
                name="d2", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=2
            ),
        ]
        spec = create_horde_spec(demons)

        assert len(spec.demons) == 3
        chex.assert_shape(spec.gammas, (3,))
        chex.assert_shape(spec.lamdas, (3,))

        # Check pre-computed arrays
        chex.assert_trees_all_close(spec.gammas, jnp.array([0.0, 0.9, 0.0]))
        chex.assert_trees_all_close(spec.lamdas, jnp.array([0.0, 0.8, 0.0]))

    def test_config_roundtrip(self):
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
            GVFSpec(
                name="d1", demon_type=DemonType.PREDICTION, gamma=0.95, lamda=0.5, cumulant_index=1
            ),
        ]
        original = create_horde_spec(demons)
        config = original.to_config()
        restored = HordeSpec.from_config(config)

        assert len(restored.demons) == 2
        assert restored.demons[0].name == "d0"
        assert restored.demons[1].gamma == 0.95
        chex.assert_trees_all_close(restored.gammas, original.gammas)
        chex.assert_trees_all_close(restored.lamdas, original.lamdas)

    def test_rlsecd_5_head_spec(self):
        """Validate rlsecd's 5-head configuration as GVF demons.

        All heads are single-step prediction demons (gamma=0, pi=behavior).
        """
        rlsecd_demons = [
            GVFSpec(
                name="is_malicious",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=0,
            ),
            GVFSpec(
                name="attack_type",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=1,
            ),
            GVFSpec(
                name="severity",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=2,
            ),
            GVFSpec(
                name="confidence",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=3,
            ),
            GVFSpec(
                name="action_quality",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=4,
            ),
        ]
        spec = create_horde_spec(rlsecd_demons)

        assert len(spec.demons) == 5
        # All gammas should be 0 (single-step prediction)
        chex.assert_trees_all_close(spec.gammas, jnp.zeros(5))
        chex.assert_trees_all_close(spec.lamdas, jnp.zeros(5))

        # All should be prediction demons
        for d in spec.demons:
            assert d.demon_type is DemonType.PREDICTION

    def test_single_demon(self):
        spec = create_horde_spec(
            [
                GVFSpec(
                    name="only",
                    demon_type=DemonType.PREDICTION,
                    gamma=0.99,
                    lamda=0.9,
                    cumulant_index=0,
                ),
            ]
        )
        assert len(spec.demons) == 1
        chex.assert_shape(spec.gammas, (1,))

    def test_demons_are_tuple(self):
        """Demons should be stored as tuple for immutability."""
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
        ]
        spec = create_horde_spec(demons)
        assert isinstance(spec.demons, tuple)
