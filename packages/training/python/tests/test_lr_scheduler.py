"""
Tests for Learning Rate Scheduling and AtroposTrainingConfig.

Tests cover:
- LR scheduler types (constant, linear, cosine)
- Warmup behavior
- Boundary conditions (step 0, step == total_steps)
- Minimum LR ratio enforcement
- Config validation
- Checkpoint resume logic
"""

import math
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

try:
    import torch
    from torch.optim import AdamW
except ImportError:
    pytest.skip("torch not installed", allow_module_level=True)

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.training.atropos_trainer import (
    AtroposTrainingConfig,
    AtroposTrainer,
    LRSchedulerType,
    get_lr_scheduler,
)


class TestLRSchedulerType:
    """Tests for LRSchedulerType enum"""
    
    def test_all_types_defined(self):
        """Verify all scheduler types exist"""
        assert LRSchedulerType.CONSTANT.value == "constant"
        assert LRSchedulerType.LINEAR.value == "linear"
        assert LRSchedulerType.COSINE.value == "cosine"
    
    def test_type_count(self):
        """Verify expected number of types"""
        assert len(LRSchedulerType) == 3
    
    def test_from_string(self):
        """Test creating scheduler type from string"""
        assert LRSchedulerType("constant") == LRSchedulerType.CONSTANT
        assert LRSchedulerType("linear") == LRSchedulerType.LINEAR
        assert LRSchedulerType("cosine") == LRSchedulerType.COSINE
    
    def test_invalid_type_raises(self):
        """Test invalid type raises ValueError"""
        with pytest.raises(ValueError):
            LRSchedulerType("invalid")


class TestConstantScheduler:
    """Tests for constant LR scheduler"""
    
    @pytest.fixture
    def optimizer(self):
        """Create a simple optimizer for testing"""
        model = torch.nn.Linear(10, 10)
        return AdamW(model.parameters(), lr=1e-4)
    
    def test_constant_no_decay(self, optimizer):
        """Test constant scheduler maintains LR throughout training"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.CONSTANT,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=0.1,
        )
        
        lrs = []
        for _ in range(100):
            lrs.append(scheduler.get_last_lr()[0])
            scheduler.step()
        
        # All LRs should be the same (within floating point tolerance)
        assert all(abs(lr - 1e-4) < 1e-10 for lr in lrs)
    
    def test_constant_with_warmup(self, optimizer):
        """Test constant scheduler with warmup phase"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.CONSTANT,
            num_training_steps=100,
            warmup_steps=10,
            min_lr_ratio=0.1,
        )
        
        warmup_lrs = []
        for _ in range(10):
            warmup_lrs.append(scheduler.get_last_lr()[0])
            scheduler.step()
        
        post_warmup_lrs = []
        for _ in range(90):
            post_warmup_lrs.append(scheduler.get_last_lr()[0])
            scheduler.step()
        
        # Warmup should increase LR
        assert warmup_lrs[0] < warmup_lrs[-1]
        
        # Post warmup should be constant at full LR
        assert all(abs(lr - 1e-4) < 1e-10 for lr in post_warmup_lrs)


class TestLinearScheduler:
    """Tests for linear LR scheduler"""
    
    @pytest.fixture
    def optimizer(self):
        model = torch.nn.Linear(10, 10)
        return AdamW(model.parameters(), lr=1e-4)
    
    def test_linear_decay(self, optimizer):
        """Test linear scheduler decays LR linearly"""
        min_lr_ratio = 0.1
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.LINEAR,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=min_lr_ratio,
        )
        
        lrs = []
        for _ in range(100):
            lrs.append(scheduler.get_last_lr()[0])
            scheduler.step()
        
        # Should start at initial LR
        assert abs(lrs[0] - 1e-4) < 1e-10
        
        # Should end near min LR (use relative tolerance for floating point)
        expected_min = 1e-4 * min_lr_ratio
        assert abs(lrs[-1] - expected_min) / expected_min < 0.1  # 10% relative tolerance
        
        # Should be monotonically decreasing
        for i in range(1, len(lrs)):
            assert lrs[i] <= lrs[i-1] + 1e-12  # Small tolerance for floating point
    
    def test_linear_with_warmup(self, optimizer):
        """Test linear scheduler with warmup"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.LINEAR,
            num_training_steps=100,
            warmup_steps=20,
            min_lr_ratio=0.1,
        )
        
        # Warmup phase
        for step in range(20):
            lr = scheduler.get_last_lr()[0]
            expected = 1e-4 * (step / 20)
            assert abs(lr - expected) < 1e-10, f"Step {step}: expected {expected}, got {lr}"
            scheduler.step()
        
        # After warmup, should be at full LR
        assert abs(scheduler.get_last_lr()[0] - 1e-4) < 1e-10
    
    def test_linear_min_lr_respected(self, optimizer):
        """Test that LR never goes below min_lr_ratio"""
        min_lr_ratio = 0.2
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.LINEAR,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=min_lr_ratio,
        )
        
        min_expected = 1e-4 * min_lr_ratio
        
        for _ in range(150):  # Go beyond training steps
            lr = scheduler.get_last_lr()[0]
            assert lr >= min_expected - 1e-12
            scheduler.step()


class TestCosineScheduler:
    """Tests for cosine annealing LR scheduler"""
    
    @pytest.fixture
    def optimizer(self):
        model = torch.nn.Linear(10, 10)
        return AdamW(model.parameters(), lr=1e-4)
    
    def test_cosine_decay(self, optimizer):
        """Test cosine scheduler follows cosine curve"""
        min_lr_ratio = 0.1
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=min_lr_ratio,
        )
        
        lrs = []
        for _ in range(100):
            lrs.append(scheduler.get_last_lr()[0])
            scheduler.step()
        
        # Should start at initial LR
        assert abs(lrs[0] - 1e-4) < 1e-10
        
        # Should end near min LR (use relative tolerance)
        expected_min = 1e-4 * min_lr_ratio
        assert abs(lrs[-1] - expected_min) / expected_min < 0.1  # 10% relative tolerance
        
        # Should follow cosine curve shape
        # At step 50 (halfway), should be near midpoint
        step_50_expected = 0.5 * (1e-4 * min_lr_ratio + 1e-4)
        assert abs(lrs[50] - step_50_expected) < 1e-6
    
    def test_cosine_with_warmup(self, optimizer):
        """Test cosine scheduler with warmup"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=100,
            warmup_steps=10,
            min_lr_ratio=0.1,
        )
        
        # Warmup should increase linearly
        for step in range(10):
            lr = scheduler.get_last_lr()[0]
            expected = 1e-4 * (step / 10)
            assert abs(lr - expected) < 1e-10
            scheduler.step()
        
        # After warmup, should start cosine from full LR
        assert abs(scheduler.get_last_lr()[0] - 1e-4) < 1e-10
    
    def test_cosine_min_lr_respected(self, optimizer):
        """Test that LR never goes below min_lr_ratio"""
        min_lr_ratio = 0.3
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=min_lr_ratio,
        )
        
        min_expected = 1e-4 * min_lr_ratio
        
        for _ in range(150):  # Go beyond training steps
            lr = scheduler.get_last_lr()[0]
            assert lr >= min_expected - 1e-10
            scheduler.step()
    
    def test_cosine_smooth_transition(self, optimizer):
        """Test cosine has smooth transitions (no discontinuities)"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=0.1,
        )
        
        lrs = []
        for _ in range(100):
            lrs.append(scheduler.get_last_lr()[0])
            scheduler.step()
        
        # Check that changes between steps are gradual
        for i in range(1, len(lrs)):
            delta = abs(lrs[i] - lrs[i-1])
            # Max change should be reasonable (< 5% of initial LR per step)
            assert delta < 1e-4 * 0.05


class TestWarmupBehavior:
    """Tests specifically for warmup behavior"""
    
    @pytest.fixture
    def optimizer(self):
        model = torch.nn.Linear(10, 10)
        return AdamW(model.parameters(), lr=1e-4)
    
    def test_zero_warmup_steps(self, optimizer):
        """Test scheduler works with zero warmup steps"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=0.1,
        )
        
        # Should start at full LR immediately
        assert abs(scheduler.get_last_lr()[0] - 1e-4) < 1e-10
    
    def test_warmup_at_step_zero(self, optimizer):
        """Test warmup starts at zero LR"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=100,
            warmup_steps=10,
            min_lr_ratio=0.1,
        )
        
        # At step 0, LR should be 0
        assert scheduler.get_last_lr()[0] == 0.0
    
    def test_warmup_reaches_full_lr(self, optimizer):
        """Test warmup reaches full LR at end of warmup"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=100,
            warmup_steps=10,
            min_lr_ratio=0.1,
        )
        
        # Step through warmup
        for _ in range(10):
            scheduler.step()
        
        # Should be at full LR
        assert abs(scheduler.get_last_lr()[0] - 1e-4) < 1e-10
    
    def test_warmup_equal_to_total_steps(self, optimizer):
        """Test edge case where warmup == total steps"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.LINEAR,
            num_training_steps=10,
            warmup_steps=10,
            min_lr_ratio=0.1,
        )
        
        # Should complete warmup and not crash
        for _ in range(15):
            scheduler.step()
    
    def test_warmup_greater_than_total_steps(self, optimizer):
        """Test edge case where warmup > total steps"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.LINEAR,
            num_training_steps=10,
            warmup_steps=20,
            min_lr_ratio=0.1,
        )
        
        # Should not crash
        for step in range(25):
            lr = scheduler.get_last_lr()[0]
            scheduler.step()


class TestAtroposTrainingConfig:
    """Tests for AtroposTrainingConfig"""
    
    def test_default_values(self):
        """Test all default values are set correctly"""
        config = AtroposTrainingConfig()
        
        assert config.model_name == "Qwen/Qwen2.5-3B-Instruct"
        assert config.learning_rate == 1e-5
        assert config.min_learning_rate == 1e-7
        assert config.training_steps == 100
        assert config.batch_size == 4
        assert config.gradient_accumulation_steps == 8
        assert config.seq_len == 4096
        assert config.max_grad_norm == 1.0
        assert config.lr_scheduler == LRSchedulerType.COSINE
        assert config.warmup_steps == 10
        assert config.vllm_port == 9001
        assert config.vllm_restart_interval == 5
        assert config.vllm_gpu_utilization == 0.45
        assert config.save_path == "./trained_models"
        assert config.save_every_steps == 5
        assert config.keep_checkpoints == 3
        assert config.resume_from is None
        assert config.api_url == "http://localhost:8000"
        assert config.log_to_file is True
        assert config.log_file == "./logs/training_metrics.jsonl"
        assert config.use_wandb is True
        assert config.wandb_project == "eliza-training"
        assert config.wandb_entity is None
        assert config.wandb_run_name is None
    
    def test_custom_values(self):
        """Test custom values override defaults"""
        config = AtroposTrainingConfig(
            model_name="custom/model",
            learning_rate=5e-5,
            training_steps=50,
            lr_scheduler=LRSchedulerType.LINEAR,
            use_wandb=False,
        )
        
        assert config.model_name == "custom/model"
        assert config.learning_rate == 5e-5
        assert config.training_steps == 50
        assert config.lr_scheduler == LRSchedulerType.LINEAR
        assert config.use_wandb is False
    
    def test_min_lr_ratio_calculation(self):
        """Test min_lr_ratio is calculated correctly from config"""
        config = AtroposTrainingConfig(
            learning_rate=1e-4,
            min_learning_rate=1e-6,
        )
        
        expected_ratio = config.min_learning_rate / config.learning_rate
        assert abs(expected_ratio - 0.01) < 1e-10
    
    def test_device_auto_detection(self):
        """Test device is auto-detected"""
        config = AtroposTrainingConfig()
        
        if torch.cuda.is_available():
            assert config.device == "cuda"
        else:
            assert config.device == "cpu"
    
    def test_device_override(self):
        """Test device can be overridden"""
        config = AtroposTrainingConfig(device="cpu")
        assert config.device == "cpu"


class TestAtroposTrainer:
    """Tests for AtroposTrainer class"""
    
    def test_initialization(self):
        """Test trainer initializes correctly"""
        config = AtroposTrainingConfig()
        trainer = AtroposTrainer(config)
        
        assert trainer.config == config
        assert trainer.model is None
        assert trainer.tokenizer is None
        assert trainer.optimizer is None
        assert trainer.scheduler is None
        assert trainer.current_step == 0
        assert trainer.vllm_process is None
        assert trainer._wandb_initialized is False
        assert trainer._checkpoint_history == []
        assert len(trainer.run_id) > 0
    
    def test_extract_step_from_path_valid(self):
        """Test step extraction from checkpoint path"""
        config = AtroposTrainingConfig()
        trainer = AtroposTrainer(config)
        
        assert trainer._extract_step_from_path("./models/step_50") == 50
        assert trainer._extract_step_from_path("/path/to/step_100") == 100
        assert trainer._extract_step_from_path("step_0") == 0
        assert trainer._extract_step_from_path("step_999") == 999
    
    def test_extract_step_from_path_invalid(self):
        """Test step extraction with invalid paths"""
        config = AtroposTrainingConfig()
        trainer = AtroposTrainer(config)
        
        # Non-step paths should return 0
        assert trainer._extract_step_from_path("./models/final_model") == 0
        assert trainer._extract_step_from_path("./models/checkpoint") == 0
        assert trainer._extract_step_from_path("./step_abc") == 0
        assert trainer._extract_step_from_path("") == 0
    
    def test_extract_step_from_path_edge_cases(self):
        """Test step extraction edge cases"""
        config = AtroposTrainingConfig()
        trainer = AtroposTrainer(config)
        
        # Path with just "step_"
        assert trainer._extract_step_from_path("step_") == 0
        
        # Path with negative-looking number (should not match)
        assert trainer._extract_step_from_path("step_-5") == 0
        
        # Leading zeros
        assert trainer._extract_step_from_path("step_007") == 7
    
    def test_run_id_format(self):
        """Test run_id is in expected format"""
        config = AtroposTrainingConfig()
        trainer = AtroposTrainer(config)
        
        # Should be YYYYMMDD-HHMMSS format
        assert len(trainer.run_id) == 15
        assert trainer.run_id[8] == '-'
        assert trainer.run_id[:8].isdigit()
        assert trainer.run_id[9:].isdigit()


class TestBoundaryConditions:
    """Tests for various boundary conditions"""
    
    @pytest.fixture
    def optimizer(self):
        model = torch.nn.Linear(10, 10)
        return AdamW(model.parameters(), lr=1e-4)
    
    def test_single_training_step(self, optimizer):
        """Test scheduler with only 1 training step"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=1,
            warmup_steps=0,
            min_lr_ratio=0.1,
        )
        
        # Should not crash
        lr = scheduler.get_last_lr()[0]
        scheduler.step()
        
        assert lr >= 0
    
    def test_min_lr_ratio_zero(self, optimizer):
        """Test with min_lr_ratio of 0 (decay to zero)"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.LINEAR,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=0.0,
        )
        
        for _ in range(100):
            scheduler.step()
        
        # Should be at or very near 0
        assert scheduler.get_last_lr()[0] < 1e-12
    
    def test_min_lr_ratio_one(self, optimizer):
        """Test with min_lr_ratio of 1 (no decay)"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.LINEAR,
            num_training_steps=100,
            warmup_steps=0,
            min_lr_ratio=1.0,
        )
        
        lrs = []
        for _ in range(100):
            lrs.append(scheduler.get_last_lr()[0])
            scheduler.step()
        
        # All should be at initial LR
        assert all(abs(lr - 1e-4) < 1e-10 for lr in lrs)
    
    def test_very_large_step_count(self, optimizer):
        """Test scheduler handles large step counts"""
        scheduler = get_lr_scheduler(
            optimizer=optimizer,
            scheduler_type=LRSchedulerType.COSINE,
            num_training_steps=1000000,
            warmup_steps=1000,
            min_lr_ratio=0.01,
        )
        
        # Just verify it doesn't crash or produce NaN
        for _ in range(1000):
            lr = scheduler.get_last_lr()[0]
            assert not math.isnan(lr)
            assert not math.isinf(lr)
            scheduler.step()
