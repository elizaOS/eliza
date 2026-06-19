"""Tests for APOLLO, Kondo gate, and TurboQuant extensions in atropos_trainer."""

from __future__ import annotations

import torch

from src.training.atropos_trainer import (
    AtroposTrainingConfig,
    _build_apollo_param_groups,
    _create_optimizer,
)

# ─── Config ─────────────────────────────────────────────────────────────────


class TestAtroposTrainingConfig:
    def test_default_optimizer_is_apollo(self) -> None:
        config = AtroposTrainingConfig()
        assert config.optimizer == "apollo"

    def test_kondo_defaults_enabled(self) -> None:
        config = AtroposTrainingConfig()
        assert config.use_kondo is True
        assert config.kondo_gate_rate == 0.3

    def test_turboquant_defaults_enabled(self) -> None:
        config = AtroposTrainingConfig()
        assert config.use_turboquant is True

    def test_apollo_config(self) -> None:
        config = AtroposTrainingConfig(
            optimizer="apollo",
            apollo_rank=256,
            apollo_scale=64.0,
            apollo_update_proj_gap=100,
        )
        assert config.optimizer == "apollo"
        assert config.apollo_rank == 256

    def test_full_online_config(self) -> None:
        """Test the recommended online RL configuration."""
        config = AtroposTrainingConfig(
            optimizer="apollo",
            use_kondo=True,
            kondo_gate_rate=0.03,
            use_turboquant=True,
            turboquant_key_bits=3.5,
            turboquant_value_bits=3.5,
        )
        assert config.optimizer == "apollo"
        assert config.use_kondo is True
        assert config.kondo_gate_rate == 0.03
        assert config.use_turboquant is True


# ─── APOLLO param groups ────────────────────────────────────────────────────


class _FakeModel(torch.nn.Module):
    """Minimal model that has named parameters matching APOLLO targets."""

    def __init__(self):
        super().__init__()
        self.q_proj = torch.nn.Linear(64, 64)
        self.k_proj = torch.nn.Linear(64, 64)
        self.v_proj = torch.nn.Linear(64, 64)
        self.o_proj = torch.nn.Linear(64, 64)
        self.gate_proj = torch.nn.Linear(64, 256)
        self.up_proj = torch.nn.Linear(64, 256)
        self.down_proj = torch.nn.Linear(256, 64)
        self.norm = torch.nn.LayerNorm(64)  # Not a low-rank target
        self.embed = torch.nn.Embedding(100, 64)  # 2D but not a target name


class TestBuildApolloParamGroups:
    def test_separates_lowrank_and_regular(self) -> None:
        model = _FakeModel()
        groups = _build_apollo_param_groups(
            model, apollo_rank=128, apollo_scale=32.0, apollo_update_proj_gap=200
        )

        # Should have 2 groups: regular and low-rank
        assert len(groups) == 2

        regular_group = groups[0]
        lowrank_group = groups[1]

        # Low-rank group should have APOLLO settings
        assert lowrank_group["rank"] == 128
        assert lowrank_group["proj"] == "random"
        assert lowrank_group["scale_type"] == "channel"
        assert lowrank_group["scale"] == 32.0

        # Regular group should NOT have rank
        assert "rank" not in regular_group

    def test_lowrank_group_contains_projection_params(self) -> None:
        model = _FakeModel()
        groups = _build_apollo_param_groups(
            model, apollo_rank=128, apollo_scale=32.0, apollo_update_proj_gap=200
        )

        lowrank_params = groups[1]["params"]
        # q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj
        # Each has weight + bias = 14 params, but only ndim >= 2 are included
        # So weights only (7 weight matrices)
        weight_count = sum(1 for p in lowrank_params if p.ndim >= 2)
        assert weight_count >= 7


# ─── Optimizer creation ─────────────────────────────────────────────────────


class TestCreateOptimizer:
    def test_creates_adamw(self) -> None:
        model = _FakeModel()
        opt = _create_optimizer(model, "adamw", lr=1e-4)
        assert isinstance(opt, torch.optim.AdamW)

    def test_apollo_import_error_gives_useful_message(self) -> None:
        model = _FakeModel()
        # If apollo_torch isn't installed, we should get a clear error
        try:
            opt = _create_optimizer(model, "apollo", lr=1e-4)
            # If it succeeds, apollo_torch is installed — verify it has the
            # APOLLO-specific param group keys (rank, proj, scale_type)
            has_apollo_groups = any("rank" in pg for pg in opt.param_groups)
            assert has_apollo_groups, "APOLLO optimizer should have param groups with 'rank'"
        except ImportError as e:
            assert "apollo_torch" in str(e)
