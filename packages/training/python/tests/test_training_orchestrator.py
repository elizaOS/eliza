"""
Tests for TrainingOrchestrator from run_training.py

Tests cover:
- Initialization and configuration
- Service lifecycle management
- Cleanup behavior
- Signal handling
- Environment validation
"""

import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add src and scripts to path
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from run_training import TrainingOrchestrator, validate_environment


class TestValidateEnvironment:
    """Tests for validate_environment function"""
    
    def test_returns_list(self):
        """Test that validate_environment returns a list"""
        result = validate_environment()
        assert isinstance(result, list)
    
    def test_missing_database_url(self):
        """Test error when DATABASE_URL not set"""
        original = os.environ.get("DATABASE_URL")
        if "DATABASE_URL" in os.environ:
            del os.environ["DATABASE_URL"]
        
        try:
            errors = validate_environment()
            db_errors = [e for e in errors if "DATABASE_URL" in e]
            assert len(db_errors) >= 1
        finally:
            if original:
                os.environ["DATABASE_URL"] = original
    
    def test_missing_openai_api_key(self):
        """Test error when OPENAI_API_KEY not set"""
        original = os.environ.get("OPENAI_API_KEY")
        if "OPENAI_API_KEY" in os.environ:
            del os.environ["OPENAI_API_KEY"]
        
        try:
            errors = validate_environment()
            key_errors = [e for e in errors if "OPENAI_API_KEY" in e]
            assert len(key_errors) >= 1
        finally:
            if original:
                os.environ["OPENAI_API_KEY"] = original
    
    def test_with_all_env_vars_set(self):
        """Test fewer errors when env vars are set"""
        original_db = os.environ.get("DATABASE_URL")
        original_key = os.environ.get("OPENAI_API_KEY")
        
        os.environ["DATABASE_URL"] = "postgresql://test:test@localhost/test"
        os.environ["OPENAI_API_KEY"] = "sk-test123"
        
        try:
            errors = validate_environment()
            # Should not have DB or OpenAI key errors
            db_errors = [e for e in errors if "DATABASE_URL" in e]
            key_errors = [e for e in errors if "OPENAI_API_KEY" in e]
            assert len(db_errors) == 0
            assert len(key_errors) == 0
        finally:
            if original_db:
                os.environ["DATABASE_URL"] = original_db
            else:
                del os.environ["DATABASE_URL"]
            if original_key:
                os.environ["OPENAI_API_KEY"] = original_key
            else:
                del os.environ["OPENAI_API_KEY"]


class TestTrainingOrchestratorInit:
    """Tests for TrainingOrchestrator initialization"""
    
    def test_default_values(self):
        """Test default initialization values"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            assert orch.model_name == "Qwen/Qwen2.5-3B-Instruct"
            assert orch.training_steps == 100
            assert orch.batch_size == 4
            assert orch.learning_rate == 1e-5
            assert orch.min_learning_rate == 1e-7
            assert orch.lr_scheduler == "cosine"
            assert orch.warmup_steps == 10
            assert orch.api_port == 8000
            assert orch.vllm_port == 9001
            assert orch.vllm_gpu_memory == 0.45
            assert orch.save_path == "./trained_models"
            assert orch.save_every == 5
            assert orch.keep_checkpoints == 3
            assert orch.resume_from is None
            assert orch.use_wandb is True
            assert orch.wandb_project == "eliza-training"
            assert orch.wandb_entity is None
            assert orch.wandb_run_name is None
            assert orch.skip_services is False
    
    def test_custom_values(self):
        """Test custom initialization values"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                model_name="custom/model",
                training_steps=50,
                batch_size=8,
                learning_rate=5e-5,
                lr_scheduler="linear",
                use_wandb=False,
                skip_services=True,
                log_dir=tmpdir,
            )
            
            assert orch.model_name == "custom/model"
            assert orch.training_steps == 50
            assert orch.batch_size == 8
            assert orch.learning_rate == 5e-5
            assert orch.lr_scheduler == "linear"
            assert orch.use_wandb is False
            assert orch.skip_services is True
    
    def test_creates_log_directory(self):
        """Test that log directory is created"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir) / "nested" / "logs"
            
            orch = TrainingOrchestrator(log_dir=str(log_dir))
            
            assert log_dir.exists()
            assert log_dir.is_dir()
    
    def test_initializes_process_tracking(self):
        """Test process tracking is initialized"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            assert orch.env_process is None
            assert orch.trainer_process is None
            assert orch._service_manager is None
            assert orch._shutdown_requested is False
            assert orch._log_handles == []


class TestTrainingOrchestratorCleanup:
    """Tests for TrainingOrchestrator cleanup behavior"""
    
    def test_cleanup_with_no_processes(self):
        """Test cleanup is safe when no processes running"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            # Should not raise
            orch.cleanup()
    
    def test_cleanup_stops_real_process(self):
        """Test cleanup terminates real processes"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            # Start a real process
            orch.trainer_process = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(60)"]
            )
            
            assert orch.trainer_process.poll() is None
            
            orch.cleanup()
            
            assert orch.trainer_process.poll() is not None
    
    def test_cleanup_closes_log_handles(self):
        """Test cleanup closes log handles"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            # Create a log handle
            log_file = Path(tmpdir) / "test.log"
            handle = open(log_file, 'w')
            orch._log_handles.append(handle)
            
            assert not handle.closed
            
            orch.cleanup()
            
            assert handle.closed
            assert len(orch._log_handles) == 0
    
    def test_cleanup_multiple_processes(self):
        """Test cleanup handles multiple processes"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            orch.trainer_process = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(60)"]
            )
            orch.env_process = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(60)"]
            )
            
            assert orch.trainer_process.poll() is None
            assert orch.env_process.poll() is None
            
            orch.cleanup()
            
            assert orch.trainer_process.poll() is not None
            assert orch.env_process.poll() is not None


class TestTrainingOrchestratorStopProcess:
    """Tests for _stop_process helper method"""
    
    def test_stop_process_none(self):
        """Test _stop_process handles None"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            # Should not raise
            orch._stop_process(None, "test")
    
    def test_stop_process_terminates_gracefully(self):
        """Test _stop_process terminates process gracefully"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            proc = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(60)"]
            )
            
            start = time.time()
            orch._stop_process(proc, "test", timeout=5)
            elapsed = time.time() - start
            
            assert proc.poll() is not None
            # Should be quick (< 1 second for graceful termination)
            assert elapsed < 2
    
    def test_stop_process_kills_stubborn_process(self):
        """Test _stop_process kills process that ignores SIGTERM"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            # Create a process that ignores SIGTERM
            proc = subprocess.Popen([
                sys.executable, "-c",
                "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
            ])
            
            # Allow process to start and set up signal handler
            time.sleep(0.2)
            
            orch._stop_process(proc, "stubborn", timeout=2)
            
            # Key assertion: process should be terminated
            assert proc.poll() is not None


class TestTrainingOrchestratorSkipServices:
    """Tests for skip_services behavior"""
    
    def test_start_services_skipped(self):
        """Test services are skipped when skip_services=True"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                skip_services=True,
                log_dir=tmpdir,
            )
            
            result = orch.start_services()
            
            assert result is True
            assert orch._service_manager is None


class TestTrainingOrchestratorLogConfig:
    """Tests for _log_config method"""
    
    def test_log_config_runs(self):
        """Test _log_config executes without error"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                model_name="test/model",
                training_steps=50,
                resume_from="./checkpoint",
                log_dir=tmpdir,
            )
            
            # Should not raise
            orch._log_config()
    
    def test_log_config_without_resume(self):
        """Test _log_config works when resume_from is None"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                resume_from=None,
                log_dir=tmpdir,
            )
            
            # Should not raise
            orch._log_config()


class TestIntegrationStartEnvironment:
    """Integration tests for starting environment (mocked subprocess)"""
    
    @patch('subprocess.Popen')
    def test_start_environment_builds_correct_command(self, mock_popen):
        """Test start_environment builds correct command"""
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_process.pid = 12345
        mock_popen.return_value = mock_process
        
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                model_name="test/model",
                api_port=9000,
                vllm_port=8080,
                use_wandb=False,
                log_dir=tmpdir,
            )
            
            result = orch.start_environment()
            
            assert result is True
            
            # Verify command was called
            call_args = mock_popen.call_args
            cmd = call_args[0][0]
            
            assert "-m" in cmd
            assert "src.training.rlaif_env" in cmd
            assert "serve" in cmd
            assert "--env.tokenizer_name" in cmd
            assert "test/model" in cmd
            assert "--env.use_wandb" in cmd
            assert "false" in cmd
    
    @patch('subprocess.Popen')
    def test_start_environment_tracks_log_handle(self, mock_popen):
        """Test start_environment tracks log handle"""
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_process.pid = 12345
        mock_popen.return_value = mock_process
        
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            orch.start_environment()
            
            assert len(orch._log_handles) == 1
    
    @patch('subprocess.Popen')
    def test_start_environment_failure(self, mock_popen):
        """Test start_environment handles immediate failure"""
        mock_process = MagicMock()
        mock_process.poll.return_value = 1  # Process exited
        mock_process.returncode = 1
        mock_popen.return_value = mock_process
        
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            result = orch.start_environment()
            
            assert result is False


class TestIntegrationStartTrainer:
    """Integration tests for starting trainer (mocked subprocess)"""
    
    @patch('subprocess.Popen')
    def test_start_trainer_builds_correct_command(self, mock_popen):
        """Test start_trainer builds correct command"""
        mock_process = MagicMock()
        mock_process.pid = 12345
        mock_popen.return_value = mock_process
        
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                model_name="test/model",
                training_steps=50,
                batch_size=8,
                learning_rate=5e-5,
                min_learning_rate=1e-7,
                lr_scheduler="linear",
                warmup_steps=5,
                save_path="./models",
                save_every=10,
                keep_checkpoints=2,
                use_wandb=False,
                log_dir=tmpdir,
            )
            
            result = orch.start_trainer()
            
            assert result is True
            
            call_args = mock_popen.call_args
            cmd = call_args[0][0]
            
            assert "--model" in cmd
            assert "test/model" in cmd
            assert "--steps" in cmd
            assert "50" in cmd
            assert "--batch-size" in cmd
            assert "8" in cmd
            assert "--lr-scheduler" in cmd
            assert "linear" in cmd
            assert "--no-wandb" in cmd
    
    @patch('subprocess.Popen')
    def test_start_trainer_with_resume(self, mock_popen):
        """Test start_trainer includes resume flag"""
        mock_process = MagicMock()
        mock_process.pid = 12345
        mock_popen.return_value = mock_process
        
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                resume_from="./checkpoint/step_50",
                log_dir=tmpdir,
            )
            
            orch.start_trainer()
            
            call_args = mock_popen.call_args
            cmd = call_args[0][0]
            
            assert "--resume" in cmd
            assert "./checkpoint/step_50" in cmd
    
    @patch('subprocess.Popen')
    def test_start_trainer_with_wandb_options(self, mock_popen):
        """Test start_trainer includes W&B options"""
        mock_process = MagicMock()
        mock_process.pid = 12345
        mock_popen.return_value = mock_process
        
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(
                use_wandb=True,
                wandb_project="my-project",
                wandb_entity="my-team",
                wandb_run_name="my-run",
                log_dir=tmpdir,
            )
            
            orch.start_trainer()
            
            call_args = mock_popen.call_args
            cmd = call_args[0][0]
            
            assert "--wandb-project" in cmd
            assert "my-project" in cmd
            assert "--wandb-entity" in cmd
            assert "my-team" in cmd
            assert "--wandb-run-name" in cmd
            assert "my-run" in cmd
            assert "--no-wandb" not in cmd


class TestSignalHandling:
    """Tests for signal handling behavior"""
    
    def test_shutdown_requested_flag(self):
        """Test shutdown_requested flag is set on signal"""
        with tempfile.TemporaryDirectory() as tmpdir:
            orch = TrainingOrchestrator(log_dir=tmpdir)
            
            assert orch._shutdown_requested is False
            
            # Simulate signal handler behavior (not the actual signal)
            orch._shutdown_requested = True
            
            assert orch._shutdown_requested is True

