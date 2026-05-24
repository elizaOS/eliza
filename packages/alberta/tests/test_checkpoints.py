"""Tests for checkpoint save/load utilities."""

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework import (
    Autostep,
    EMANormalizer,
    LinearLearner,
    MLPLearner,
    MultiHeadMLPLearner,
    ObGDBounding,
    checkpoint_exists,
    load_checkpoint,
    load_checkpoint_metadata,
    save_checkpoint,
)


class TestSaveLoadRoundTrip:
    """Round-trip save/load for different learner state types."""

    def test_linear_learner_state(self, tmp_path):
        """LinearLearner state should round-trip correctly."""
        learner = LinearLearner()
        state = learner.init(feature_dim=10)

        # Modify weights so they're non-zero
        state = state.replace(weights=jnp.ones(10))

        save_checkpoint(state, tmp_path / "linear")
        template = learner.init(feature_dim=10)
        loaded, meta = load_checkpoint(template, tmp_path / "linear")

        chex.assert_trees_all_close(loaded.weights, state.weights)
        chex.assert_trees_all_close(
            loaded.optimizer_state.step_size,
            state.optimizer_state.step_size,
        )
        assert int(loaded.step_count) == int(state.step_count)
        assert meta == {}

    def test_mlp_learner_state(self, tmp_path):
        """MLPLearner state should round-trip correctly."""
        learner = MLPLearner(
            hidden_sizes=(32, 16),
            step_size=0.5,
            bounder=ObGDBounding(kappa=2.0),
            sparsity=0.0,
        )
        state = learner.init(feature_dim=10, key=jr.key(42))

        save_checkpoint(state, tmp_path / "mlp")
        template = learner.init(feature_dim=10, key=jr.key(0))
        loaded, meta = load_checkpoint(template, tmp_path / "mlp")

        # Check weights match
        for i in range(len(state.params.weights)):
            chex.assert_trees_all_close(
                loaded.params.weights[i], state.params.weights[i]
            )
            chex.assert_trees_all_close(
                loaded.params.biases[i], state.params.biases[i]
            )
        assert meta == {}

    def test_multi_head_learner_state(self, tmp_path):
        """MultiHeadMLPLearner state should round-trip correctly."""
        learner = MultiHeadMLPLearner(
            n_heads=3,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        save_checkpoint(state, tmp_path / "multi_head")
        template = learner.init(feature_dim=5, key=jr.key(0))
        loaded, meta = load_checkpoint(template, tmp_path / "multi_head")

        # Check trunk params
        for i in range(len(state.trunk_params.weights)):
            chex.assert_trees_all_close(
                loaded.trunk_params.weights[i],
                state.trunk_params.weights[i],
            )

        # Check head params
        for i in range(3):
            chex.assert_trees_all_close(
                loaded.head_params.weights[i],
                state.head_params.weights[i],
            )
        assert int(loaded.step_count) == int(state.step_count)

    def test_multi_head_linear_baseline(self, tmp_path):
        """MultiHeadMLPLearner with hidden_sizes=() should round-trip."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        save_checkpoint(state, tmp_path / "linear_multi")
        template = learner.init(feature_dim=5, key=jr.key(0))
        loaded, _ = load_checkpoint(template, tmp_path / "linear_multi")

        for i in range(2):
            chex.assert_trees_all_close(
                loaded.head_params.weights[i],
                state.head_params.weights[i],
            )

    def test_with_normalizer(self, tmp_path):
        """State with EMANormalizer should round-trip."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            normalizer=EMANormalizer(decay=0.95),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        # Do an update to change normalizer state
        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])
        result = learner.update(state, obs, targets)
        state = result.state

        save_checkpoint(state, tmp_path / "normed")
        template = learner.init(feature_dim=5, key=jr.key(0))
        loaded, _ = load_checkpoint(template, tmp_path / "normed")

        chex.assert_trees_all_close(
            loaded.normalizer_state.mean,
            state.normalizer_state.mean,
        )
        chex.assert_trees_all_close(
            loaded.normalizer_state.var,
            state.normalizer_state.var,
        )

    def test_with_autostep(self, tmp_path):
        """State with Autostep optimizer should round-trip."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        save_checkpoint(state, tmp_path / "autostep")
        template = learner.init(feature_dim=5, key=jr.key(0))
        loaded, _ = load_checkpoint(template, tmp_path / "autostep")

        # Verify trunk optimizer states are preserved
        for i in range(len(state.trunk_optimizer_states)):
            chex.assert_trees_all_close(
                loaded.trunk_optimizer_states[i],
                state.trunk_optimizer_states[i],
            )


class TestMetadata:
    """Tests for metadata preservation."""

    def test_metadata_preserved(self, tmp_path):
        """User metadata should be preserved."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)
        metadata = {"epoch": 42, "optimizer": "autostep", "mae": 0.15}

        save_checkpoint(state, tmp_path / "meta", metadata=metadata)
        _, loaded_meta = load_checkpoint(state, tmp_path / "meta")

        assert loaded_meta == metadata

    def test_no_metadata(self, tmp_path):
        """Missing metadata should return empty dict."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        save_checkpoint(state, tmp_path / "nometa")
        _, loaded_meta = load_checkpoint(state, tmp_path / "nometa")

        assert loaded_meta == {}

    def test_checkpoint_directory_created(self, tmp_path):
        """Checkpoint should be saved as a directory with state/ subdirectory."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        save_checkpoint(state, tmp_path / "dircheck")

        assert (tmp_path / "dircheck").is_dir()
        assert (tmp_path / "dircheck" / "state").is_dir()
        assert (tmp_path / "dircheck" / "metadata").is_dir()


class TestErrorHandling:
    """Tests for error handling."""

    def test_missing_checkpoint(self, tmp_path):
        """Should raise FileNotFoundError for missing checkpoint."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        with pytest.raises(FileNotFoundError, match="not found"):
            load_checkpoint(state, tmp_path / "nonexistent")

    def test_missing_checkpoint_metadata_only(self, tmp_path):
        """Should raise FileNotFoundError for metadata-only load too."""
        with pytest.raises(FileNotFoundError, match="not found"):
            load_checkpoint_metadata(tmp_path / "nonexistent")

    def test_structure_mismatch(self, tmp_path):
        """Should raise ValueError when template has different structure."""
        learner_small = LinearLearner()
        state_small = learner_small.init(feature_dim=5)

        learner_mlp = MLPLearner(hidden_sizes=(16,), sparsity=0.0)
        state_mlp = learner_mlp.init(feature_dim=5, key=jr.key(42))

        save_checkpoint(state_mlp, tmp_path / "mismatch")

        with pytest.raises(ValueError, match="structure mismatch"):
            load_checkpoint(state_small, tmp_path / "mismatch")


class TestLifecycleFields:
    """Tests that Python float lifecycle fields survive round-trip."""

    def test_birth_timestamp_preserved(self, tmp_path):
        """birth_timestamp (Python float) should survive round-trip."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        save_checkpoint(state, tmp_path / "lifecycle")
        template = learner.init(feature_dim=5, key=jr.key(0))
        loaded, _ = load_checkpoint(template, tmp_path / "lifecycle")

        assert isinstance(loaded.birth_timestamp, float)
        assert loaded.birth_timestamp == pytest.approx(state.birth_timestamp)

    def test_uptime_preserved(self, tmp_path):
        """uptime_s (Python float) should survive round-trip."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))
        # Simulate some uptime
        state = state.replace(uptime_s=123.456)

        save_checkpoint(state, tmp_path / "uptime")
        template = learner.init(feature_dim=5, key=jr.key(0))
        loaded, _ = load_checkpoint(template, tmp_path / "uptime")

        assert isinstance(loaded.uptime_s, float)
        assert loaded.uptime_s == pytest.approx(123.456)


class TestPathHandling:
    """Tests for path handling edge cases."""

    def test_creates_parent_dirs(self, tmp_path):
        """save_checkpoint should create parent directories."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        save_checkpoint(state, tmp_path / "nested" / "deep" / "ckpt")
        loaded, _ = load_checkpoint(state, tmp_path / "nested" / "deep" / "ckpt")

        chex.assert_trees_all_close(loaded.weights, state.weights)

    def test_string_path(self, tmp_path):
        """String paths should work as well as Path objects."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        save_checkpoint(state, str(tmp_path / "strpath"))
        loaded, _ = load_checkpoint(state, str(tmp_path / "strpath"))

        chex.assert_trees_all_close(loaded.weights, state.weights)

    def test_checkpoint_is_directory(self, tmp_path):
        """Checkpoint should be saved as a directory."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        save_checkpoint(state, tmp_path / "test")
        assert (tmp_path / "test").is_dir()


class TestLoadCheckpointMetadata:
    """Tests for load_checkpoint_metadata (metadata-only loading)."""

    def test_metadata_without_template(self, tmp_path):
        """Should load metadata without needing a state template."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)
        metadata = {"learner_config": {"type": "mlp", "hidden": [64, 64]}, "version": 3}

        save_checkpoint(state, tmp_path / "meta_only", metadata=metadata)
        loaded_meta = load_checkpoint_metadata(tmp_path / "meta_only")

        assert loaded_meta == metadata

    def test_empty_metadata(self, tmp_path):
        """Should return empty dict when no metadata was saved."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        save_checkpoint(state, tmp_path / "no_meta")
        loaded_meta = load_checkpoint_metadata(tmp_path / "no_meta")

        assert loaded_meta == {}

    def test_internal_version_stripped(self, tmp_path):
        """Internal _format_version should not appear in returned metadata."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        save_checkpoint(state, tmp_path / "version", metadata={"epoch": 1})
        loaded_meta = load_checkpoint_metadata(tmp_path / "version")

        assert "_format_version" not in loaded_meta
        assert loaded_meta == {"epoch": 1}


class TestCheckpointExists:
    """Tests for checkpoint_exists utility."""

    def test_exists_after_save(self, tmp_path):
        """checkpoint_exists should return True after saving."""
        learner = LinearLearner()
        state = learner.init(feature_dim=5)

        assert not checkpoint_exists(tmp_path / "ckpt")
        save_checkpoint(state, tmp_path / "ckpt")
        assert checkpoint_exists(tmp_path / "ckpt")

    def test_not_exists_for_missing(self, tmp_path):
        """checkpoint_exists should return False for non-existent path."""
        assert not checkpoint_exists(tmp_path / "nonexistent")

    def test_not_exists_for_plain_file(self, tmp_path):
        """checkpoint_exists should return False for a regular file."""
        (tmp_path / "not_a_ckpt").touch()
        assert not checkpoint_exists(tmp_path / "not_a_ckpt")
