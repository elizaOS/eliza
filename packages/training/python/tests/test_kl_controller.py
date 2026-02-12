"""
Tests for KL Controller

Covers:
- KL divergence computation
- Adaptive coefficient adjustment
- State saving and loading
- Batch operations
"""

from typing import List

import pytest

from src.training.kl_controller import (
    KLConfig,
    KLControllerBase,
    KLStats,
    compute_kl_divergence,
    create_kl_controller,
)


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def basic_config():
    """Basic KL configuration"""
    return KLConfig(
        reference_model_name="test-model",
        kl_coeff=0.1,
        kl_target=3.0,
        adaptive=True,
    )


@pytest.fixture
def controller(basic_config):
    """Create a KL controller without model loading"""
    return KLControllerBase(basic_config)


@pytest.fixture
def sample_logprobs():
    """Sample log probabilities for testing"""
    policy = [-0.5, -0.3, -0.8, -0.2, -0.6]
    reference = [-0.6, -0.4, -0.7, -0.3, -0.5]
    return policy, reference


# =============================================================================
# KLConfig Tests
# =============================================================================


class TestKLConfig:
    """Tests for KLConfig dataclass"""
    
    def test_default_values(self):
        """Test default configuration values"""
        config = KLConfig(reference_model_name="test")
        
        assert config.kl_coeff == 0.1
        assert config.kl_target == 3.0
        assert config.adaptive is True
        assert config.kl_coeff_min == 0.01
        assert config.kl_coeff_max == 1.0
    
    def test_custom_values(self):
        """Test custom configuration"""
        config = KLConfig(
            reference_model_name="custom-model",
            kl_coeff=0.2,
            kl_target=5.0,
            adaptive=False,
        )
        
        assert config.kl_coeff == 0.2
        assert config.kl_target == 5.0
        assert config.adaptive is False


# =============================================================================
# KLStats Tests
# =============================================================================


class TestKLStats:
    """Tests for KLStats dataclass"""
    
    def test_default_values(self):
        """Test default statistics"""
        stats = KLStats()
        
        assert stats.mean_kl == 0.0
        assert stats.current_coeff == 0.1
        assert stats.samples_processed == 0
    
    def test_to_dict(self):
        """Test conversion to dictionary"""
        stats = KLStats(
            mean_kl=2.5,
            max_kl=5.0,
            min_kl=0.5,
            std_kl=1.2,
            current_coeff=0.15,
            adaptation_count=3,
            samples_processed=100,
        )
        
        d = stats.to_dict()
        
        assert "kl/mean" in d
        assert "kl/coeff" in d
        assert d["kl/mean"] == 2.5
        assert d["kl/samples_processed"] == 100


# =============================================================================
# KLControllerBase Tests
# =============================================================================


class TestKLControllerBase:
    """Tests for KLControllerBase"""
    
    def test_creation(self, basic_config):
        """Test creating controller"""
        controller = KLControllerBase(basic_config)
        
        assert controller.kl_coeff == 0.1
        assert len(controller._kl_history) == 0
    
    def test_compute_kl_from_logprobs(self, controller, sample_logprobs):
        """Test KL computation from logprobs"""
        policy, reference = sample_logprobs
        
        kl = controller.compute_kl_from_logprobs(policy, reference)
        
        # KL = mean(policy - reference)
        expected = sum(p - r for p, r in zip(policy, reference)) / len(policy)
        assert kl == pytest.approx(max(0, expected), abs=0.01)
    
    def test_compute_kl_empty_logprobs(self, controller):
        """Test KL with empty logprobs"""
        kl = controller.compute_kl_from_logprobs([], [])
        assert kl == 0.0
    
    def test_compute_kl_mismatched_lengths(self, controller):
        """Test KL with mismatched logprob lengths"""
        with pytest.raises(ValueError):
            controller.compute_kl_from_logprobs([1.0, 2.0], [1.0])
    
    def test_get_penalty_from_logprobs(self, controller, sample_logprobs):
        """Test getting penalty from logprobs"""
        policy, reference = sample_logprobs
        
        penalty, mean_kl = controller.get_penalty_from_logprobs(policy, reference)
        
        assert penalty >= 0
        assert mean_kl >= 0
        assert len(controller._kl_history) == 1
    
    def test_get_batch_penalty(self, controller):
        """Test batch penalty computation"""
        policy_batch = [
            [-0.5, -0.3, -0.8],
            [-0.4, -0.2, -0.7],
            [-0.6, -0.4, -0.9],
        ]
        reference_batch = [
            [-0.6, -0.4, -0.7],
            [-0.5, -0.3, -0.6],
            [-0.7, -0.5, -0.8],
        ]
        
        penalties, stats = controller.get_batch_penalty_from_logprobs(
            policy_batch, reference_batch
        )
        
        assert len(penalties) == 3
        assert stats.samples_processed == 3
        assert stats.mean_kl >= 0
    
    def test_adaptive_coefficient_increase(self, controller):
        """Test that coefficient increases when KL is high"""
        # Set target low so computed KL is "high"
        controller.config.kl_target = 0.1
        controller.config.adaptation_window = 2
        
        initial_coeff = controller.kl_coeff
        
        # Add samples with high KL
        for _ in range(5):
            controller._kl_history.append(0.5)  # High relative to target
            controller._maybe_adapt(0.5)
        
        assert controller.kl_coeff > initial_coeff
    
    def test_adaptive_coefficient_decrease(self, controller):
        """Test that coefficient decreases when KL is low"""
        # Set target high so computed KL is "low"
        controller.config.kl_target = 10.0
        controller.config.adaptation_window = 2
        
        initial_coeff = controller.kl_coeff
        
        # Add samples with low KL
        for _ in range(5):
            controller._kl_history.append(0.5)  # Low relative to target
            controller._maybe_adapt(0.5)
        
        assert controller.kl_coeff < initial_coeff
    
    def test_coefficient_bounds(self, controller):
        """Test that coefficient stays within bounds"""
        controller.config.adaptation_window = 1
        controller.config.kl_coeff_min = 0.05
        controller.config.kl_coeff_max = 0.2
        
        # Push coefficient up
        controller.config.kl_target = 0.01
        for _ in range(50):
            controller._kl_history.append(1.0)
            controller._maybe_adapt(1.0)
        
        assert controller.kl_coeff <= controller.config.kl_coeff_max
        
        # Push coefficient down
        controller.config.kl_target = 100.0
        for _ in range(50):
            controller._kl_history.append(0.01)
            controller._maybe_adapt(0.01)
        
        assert controller.kl_coeff >= controller.config.kl_coeff_min
    
    def test_non_adaptive_mode(self, basic_config):
        """Test that coefficient stays fixed in non-adaptive mode"""
        basic_config.adaptive = False
        controller = KLControllerBase(basic_config)
        
        initial_coeff = controller.kl_coeff
        
        # Add many samples
        for _ in range(100):
            controller._kl_history.append(10.0)
            controller._maybe_adapt(10.0)
        
        assert controller.kl_coeff == initial_coeff
    
    def test_get_stats(self, controller, sample_logprobs):
        """Test getting statistics"""
        policy, reference = sample_logprobs
        
        # Process some samples
        for _ in range(5):
            controller.get_penalty_from_logprobs(policy, reference)
        
        stats = controller.get_stats()
        
        assert stats.samples_processed == 5
        assert stats.mean_kl >= 0
    
    def test_reset_history(self, controller, sample_logprobs):
        """Test resetting history"""
        policy, reference = sample_logprobs
        
        controller.get_penalty_from_logprobs(policy, reference)
        assert len(controller._kl_history) == 1
        
        controller.reset_history()
        assert len(controller._kl_history) == 0
    
    def test_save_and_load_state(self, controller, sample_logprobs):
        """Test saving and loading state"""
        policy, reference = sample_logprobs
        
        # Process samples and adapt
        for _ in range(5):
            controller.get_penalty_from_logprobs(policy, reference)
        
        original_coeff = controller.kl_coeff
        original_samples = controller._samples_processed
        
        # Save state
        state = controller.save_state()
        
        # Create new controller
        new_controller = KLControllerBase(controller.config)
        new_controller.load_state(state)
        
        assert new_controller.kl_coeff == original_coeff
        assert new_controller._samples_processed == original_samples


# =============================================================================
# Factory Function Tests
# =============================================================================


class TestCreateKLController:
    """Tests for create_kl_controller factory"""
    
    def test_create_without_model(self):
        """Test creating controller without loading model"""
        controller = create_kl_controller(
            reference_model_name="test-model",
            load_model=False,
        )
        
        assert isinstance(controller, KLControllerBase)
        assert controller.config.reference_model_name == "test-model"
    
    def test_create_with_custom_config(self):
        """Test creating with custom configuration"""
        controller = create_kl_controller(
            reference_model_name="custom-model",
            kl_coeff=0.2,
            kl_target=5.0,
            adaptive=False,
            load_model=False,
        )
        
        assert controller.kl_coeff == 0.2
        assert controller.config.kl_target == 5.0
        assert controller.config.adaptive is False


# =============================================================================
# Utility Function Tests
# =============================================================================


class TestUtilityFunctions:
    """Tests for utility functions"""
    
    def test_compute_kl_divergence(self):
        """Test KL divergence computation between distributions"""
        # Identical distributions should have KL = 0
        p = [0.5, 0.3, 0.2]
        q = [0.5, 0.3, 0.2]
        
        kl = compute_kl_divergence(p, q)
        assert kl == pytest.approx(0.0, abs=0.001)
    
    def test_compute_kl_divergence_different_dists(self):
        """Test KL with different distributions"""
        p = [0.7, 0.2, 0.1]
        q = [0.3, 0.4, 0.3]
        
        kl = compute_kl_divergence(p, q)
        
        # KL should be positive for different distributions
        assert kl > 0
    
    def test_compute_kl_divergence_mismatched_lengths(self):
        """Test KL with mismatched distribution lengths"""
        with pytest.raises(ValueError):
            compute_kl_divergence([0.5, 0.5], [0.33, 0.33, 0.34])
    
    def test_kl_divergence_with_zeros(self):
        """Test KL handles zero probabilities"""
        p = [0.5, 0.5, 0.0]  # Zero in policy
        q = [0.33, 0.33, 0.34]
        
        # Should not raise, zeros in P are skipped
        kl = compute_kl_divergence(p, q)
        assert kl >= 0


# =============================================================================
# Integration Tests
# =============================================================================


class TestKLControllerIntegration:
    """Integration tests for KL controller"""
    
    def test_full_workflow(self, basic_config):
        """Test complete workflow"""
        controller = KLControllerBase(basic_config)
        
        # Simulate training loop
        for step in range(50):
            # Generate varying logprobs
            policy = [-0.5 - step * 0.01] * 10
            reference = [-0.6] * 10
            
            penalty, kl = controller.get_penalty_from_logprobs(policy, reference)
            
            assert penalty >= 0
            assert kl >= 0
        
        stats = controller.get_stats()
        assert stats.samples_processed == 50
    
    def test_batch_and_single_consistency(self, controller):
        """Test that batch and single operations give consistent results"""
        policy_batch = [
            [-0.5, -0.3],
            [-0.4, -0.2],
        ]
        reference_batch = [
            [-0.6, -0.4],
            [-0.5, -0.3],
        ]
        
        # Reset controller
        controller.reset_history()
        controller._samples_processed = 0
        
        # Single operations
        single_penalties = []
        for policy, reference in zip(policy_batch, reference_batch):
            penalty, _ = controller.get_penalty_from_logprobs(policy, reference)
            single_penalties.append(penalty)
        
        # Reset and do batch
        controller.reset_history()
        controller._samples_processed = 0
        
        batch_penalties, _ = controller.get_batch_penalty_from_logprobs(
            policy_batch, reference_batch
        )
        
        # Should be approximately equal
        for single, batch in zip(single_penalties, batch_penalties):
            assert single == pytest.approx(batch, abs=0.01)

