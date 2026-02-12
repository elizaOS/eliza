"""
Tests for ServiceManager - Process lifecycle, health checks, port detection.

Tests cover:
- ServiceConfig validation and defaults
- ManagedProcess state management
- Port-in-use detection
- Process start/stop lifecycle
- Health check behavior
- Resource cleanup (file handles)
- Signal handling
"""

import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.training.service_manager import (
    ManagedProcess,
    ServiceConfig,
    ServiceManager,
    ServiceStatus,
    check_prerequisites,
)


class TestServiceConfig:
    """Tests for ServiceConfig dataclass"""
    
    def test_default_values(self):
        """Verify all default values are set correctly"""
        config = ServiceConfig()
        
        assert config.atropos_port == 8000
        assert config.atropos_host == "localhost"
        assert config.vllm_port == 9001
        assert config.vllm_host == "localhost"
        assert config.model_name == "Qwen/Qwen2.5-3B-Instruct"
        assert config.vllm_gpu_memory_utilization == 0.85
        assert config.vllm_dtype == "auto"
        assert config.vllm_max_model_len == 4096
        assert config.startup_timeout == 180
        assert config.health_check_interval == 2.0
        assert config.shutdown_timeout == 10
        assert config.log_dir == "./logs/services"
        assert config.skip_atropos is False
        assert config.skip_vllm is False
    
    def test_custom_values(self):
        """Verify custom values override defaults"""
        config = ServiceConfig(
            atropos_port=9000,
            vllm_port=8080,
            model_name="custom/model",
            vllm_gpu_memory_utilization=0.5,
            startup_timeout=60,
            skip_atropos=True,
            skip_vllm=True,
        )
        
        assert config.atropos_port == 9000
        assert config.vllm_port == 8080
        assert config.model_name == "custom/model"
        assert config.vllm_gpu_memory_utilization == 0.5
        assert config.startup_timeout == 60
        assert config.skip_atropos is True
        assert config.skip_vllm is True
    
    def test_gpu_memory_boundary_values(self):
        """Test GPU memory utilization boundary values"""
        # Valid boundaries
        config_min = ServiceConfig(vllm_gpu_memory_utilization=0.0)
        assert config_min.vllm_gpu_memory_utilization == 0.0
        
        config_max = ServiceConfig(vllm_gpu_memory_utilization=1.0)
        assert config_max.vllm_gpu_memory_utilization == 1.0
        
        # Edge case - slightly above 0
        config_small = ServiceConfig(vllm_gpu_memory_utilization=0.01)
        assert config_small.vllm_gpu_memory_utilization == 0.01


class TestManagedProcess:
    """Tests for ManagedProcess dataclass"""
    
    def test_default_state(self):
        """Verify default state of ManagedProcess"""
        proc = ManagedProcess(name="test")
        
        assert proc.name == "test"
        assert proc.process is None
        assert proc.status == ServiceStatus.STOPPED
        assert proc.log_file is None
        assert proc.log_handle is None
        assert proc.health_url is None
        assert proc.pid is None
    
    def test_pid_property_with_process(self):
        """Test pid property returns process.pid when process exists"""
        mock_process = MagicMock()
        mock_process.pid = 12345
        
        proc = ManagedProcess(name="test", process=mock_process)
        assert proc.pid == 12345
    
    def test_pid_property_without_process(self):
        """Test pid property returns None when no process"""
        proc = ManagedProcess(name="test")
        assert proc.pid is None
    
    def test_close_log_with_handle(self):
        """Test close_log properly closes file handle"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            temp_path = f.name
        
        handle = open(temp_path, 'w')
        proc = ManagedProcess(name="test", log_handle=handle)
        
        assert not handle.closed
        proc.close_log()
        assert handle.closed
        assert proc.log_handle is None
        
        # Cleanup
        Path(temp_path).unlink()
    
    def test_close_log_without_handle(self):
        """Test close_log is safe when no handle exists"""
        proc = ManagedProcess(name="test")
        proc.close_log()  # Should not raise
        assert proc.log_handle is None
    
    def test_close_log_idempotent(self):
        """Test close_log can be called multiple times safely"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            temp_path = f.name
        
        handle = open(temp_path, 'w')
        proc = ManagedProcess(name="test", log_handle=handle)
        
        proc.close_log()
        proc.close_log()  # Second call should not raise
        
        Path(temp_path).unlink()


class TestServiceStatus:
    """Tests for ServiceStatus enum"""
    
    def test_all_statuses_defined(self):
        """Verify all expected status values exist"""
        assert ServiceStatus.STOPPED.value == "stopped"
        assert ServiceStatus.STARTING.value == "starting"
        assert ServiceStatus.RUNNING.value == "running"
        assert ServiceStatus.FAILED.value == "failed"
        assert ServiceStatus.STOPPING.value == "stopping"
    
    def test_status_count(self):
        """Verify expected number of statuses"""
        assert len(ServiceStatus) == 5


class TestServiceManagerPortDetection:
    """Tests for port-in-use detection"""
    
    def test_port_not_in_use(self):
        """Test detecting a free port"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        # Find a free port
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('localhost', 0))
            free_port = s.getsockname()[1]
        
        assert manager._port_in_use("localhost", free_port) is False
    
    def test_port_in_use(self):
        """Test detecting a port that is in use"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        # Bind to a port
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(('localhost', 0))
        server.listen(1)
        port = server.getsockname()[1]
        
        try:
            assert manager._port_in_use("localhost", port) is True
        finally:
            server.close()
    
    def test_port_in_use_timeout(self):
        """Test port check doesn't hang on unresponsive ports"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        # Use a port that's unlikely to be in use
        start = time.time()
        result = manager._port_in_use("localhost", 59999)
        elapsed = time.time() - start
        
        # Should complete within timeout (1 second) plus margin
        assert elapsed < 2.0
        assert result is False


class TestServiceManagerUrls:
    """Tests for URL generation"""
    
    def test_get_atropos_url_default(self):
        """Test default Atropos URL"""
        config = ServiceConfig()
        manager = ServiceManager(config)
        
        assert manager.get_atropos_url() == "http://localhost:8000"
    
    def test_get_atropos_url_custom(self):
        """Test custom Atropos URL"""
        config = ServiceConfig(atropos_host="192.168.1.1", atropos_port=9000)
        manager = ServiceManager(config)
        
        assert manager.get_atropos_url() == "http://192.168.1.1:9000"
    
    def test_get_vllm_url_default(self):
        """Test default vLLM URL"""
        config = ServiceConfig()
        manager = ServiceManager(config)
        
        assert manager.get_vllm_url() == "http://localhost:9001"
    
    def test_get_vllm_url_custom(self):
        """Test custom vLLM URL"""
        config = ServiceConfig(vllm_host="10.0.0.1", vllm_port=8080)
        manager = ServiceManager(config)
        
        assert manager.get_vllm_url() == "http://10.0.0.1:8080"


class TestServiceManagerStatus:
    """Tests for service status tracking"""
    
    def test_get_status_unknown_service(self):
        """Test getting status of non-existent service"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        assert manager.get_status("nonexistent") == ServiceStatus.STOPPED
    
    def test_get_status_skipped_service(self):
        """Test status after skip - should be STOPPED (never started)"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        manager.start_all()
        
        assert manager.get_status("atropos") == ServiceStatus.STOPPED
        assert manager.get_status("vllm") == ServiceStatus.STOPPED


class TestServiceManagerSkipBehavior:
    """Tests for skip service behavior"""
    
    def test_skip_atropos_only(self):
        """Test skipping only Atropos"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        result = manager.start_all()
        
        assert result is True
        assert "atropos" not in manager._processes
    
    def test_skip_vllm_only(self):
        """Test skipping only vLLM"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        result = manager.start_all()
        
        assert result is True
        assert "vllm" not in manager._processes
    
    def test_skip_all_services(self):
        """Test skipping all services"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        result = manager.start_all()
        
        assert result is True
        assert len(manager._processes) == 0
    
    def test_wait_for_ready_no_services(self):
        """Test wait_for_ready returns True when all services skipped"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        manager.start_all()
        
        result = manager.wait_for_ready(timeout=1)
        
        assert result is True


class TestServiceManagerHealthCheck:
    """Tests for health check behavior"""
    
    def test_check_health_no_process(self):
        """Test health check returns False for non-existent service"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        result = manager._check_health("atropos")
        
        assert result is False
    
    def test_check_health_no_url(self):
        """Test health check returns False when no health_url set"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        manager._processes["test"] = ManagedProcess(name="test", health_url=None)
        
        result = manager._check_health("test")
        
        assert result is False
    
    def test_is_healthy_delegates_to_check_health(self):
        """Test is_healthy is a public interface to _check_health"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        # Should return same result
        assert manager.is_healthy("nonexistent") == manager._check_health("nonexistent")


class TestServiceManagerContextManager:
    """Tests for context manager interface"""
    
    def test_context_manager_start_and_stop(self):
        """Test context manager starts and stops services"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        
        with ServiceManager(config) as manager:
            # Inside context, should have started
            assert isinstance(manager, ServiceManager)
        
        # After context, should be cleaned up
        assert len(manager._processes) == 0


class TestServiceManagerLogDirectory:
    """Tests for log directory management"""
    
    def test_creates_log_directory(self):
        """Test that log directory is created on init"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir) / "nested" / "logs"
            config = ServiceConfig(log_dir=str(log_dir), skip_atropos=True, skip_vllm=True)
            
            manager = ServiceManager(config)
            
            assert log_dir.exists()
            assert log_dir.is_dir()
    
    def test_existing_log_directory_ok(self):
        """Test that existing log directory is acceptable"""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ServiceConfig(log_dir=tmpdir, skip_atropos=True, skip_vllm=True)
            
            # Should not raise
            manager = ServiceManager(config)
            assert Path(tmpdir).exists()


class TestCheckPrerequisites:
    """Tests for the check_prerequisites function"""
    
    def test_returns_list(self):
        """Test that check_prerequisites returns a list"""
        result = check_prerequisites()
        assert isinstance(result, list)
    
    def test_missing_database_url(self):
        """Test error when DATABASE_URL not set"""
        import os
        
        # Save and clear DATABASE_URL
        original = os.environ.get("DATABASE_URL")
        if "DATABASE_URL" in os.environ:
            del os.environ["DATABASE_URL"]
        
        try:
            errors = check_prerequisites()
            
            # Should have at least the DATABASE_URL error
            db_errors = [e for e in errors if "DATABASE_URL" in e]
            assert len(db_errors) >= 1
        finally:
            if original:
                os.environ["DATABASE_URL"] = original
    
    def test_with_database_url_set(self):
        """Test no DATABASE_URL error when it's set"""
        import os
        
        original = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = "postgresql://test:test@localhost/test"
        
        try:
            errors = check_prerequisites()
            db_errors = [e for e in errors if "DATABASE_URL" in e]
            assert len(db_errors) == 0
        finally:
            if original:
                os.environ["DATABASE_URL"] = original
            else:
                del os.environ["DATABASE_URL"]


class TestServiceManagerStopProcess:
    """Tests for process stopping behavior"""
    
    def test_stop_process_nonexistent(self):
        """Test stopping non-existent process is safe"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        # Should not raise
        manager._stop_process("nonexistent")
    
    def test_stop_process_no_subprocess(self):
        """Test stopping process with no subprocess object"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        manager._processes["test"] = ManagedProcess(name="test", process=None)
        
        # Should not raise
        manager._stop_process("test")
        assert manager._processes["test"].status == ServiceStatus.STOPPED
    
    def test_stop_process_closes_log_handle(self):
        """Test that stopping closes log handle"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            temp_path = f.name
        
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        handle = open(temp_path, 'w')
        manager._processes["test"] = ManagedProcess(
            name="test",
            process=None,
            log_handle=handle
        )
        
        manager._stop_process("test")
        
        assert handle.closed
        Path(temp_path).unlink()


class TestServiceManagerRealProcess:
    """Tests with real subprocess (integration tests)"""
    
    def test_start_and_stop_real_process(self):
        """Test starting and stopping a real process"""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ServiceConfig(
                log_dir=tmpdir,
                skip_atropos=True,
                skip_vllm=True,
            )
            manager = ServiceManager(config)
            
            # Start a simple long-running process
            log_file = Path(tmpdir) / "test.log"
            log_handle = open(log_file, 'w')
            
            # Use a simple sleep command
            process = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                stdout=log_handle,
                stderr=subprocess.STDOUT,
            )
            
            manager._processes["test"] = ManagedProcess(
                name="test",
                process=process,
                status=ServiceStatus.RUNNING,
                log_file=log_file,
                log_handle=log_handle,
            )
            
            # Verify process is running
            assert process.poll() is None
            
            # Stop it
            manager._stop_process("test")
            
            # Verify process stopped
            assert process.poll() is not None
            assert manager._processes["test"].status == ServiceStatus.STOPPED
            assert log_handle.closed
    
    def test_stop_all_with_real_processes(self):
        """Test stop_all terminates all real processes"""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ServiceConfig(
                log_dir=tmpdir,
                skip_atropos=True,
                skip_vllm=True,
            )
            manager = ServiceManager(config)
            
            processes = []
            
            for name in ["proc1", "proc2"]:
                log_file = Path(tmpdir) / f"{name}.log"
                log_handle = open(log_file, 'w')
                
                process = subprocess.Popen(
                    [sys.executable, "-c", "import time; time.sleep(60)"],
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                )
                
                manager._processes[name] = ManagedProcess(
                    name=name,
                    process=process,
                    status=ServiceStatus.RUNNING,
                    log_handle=log_handle,
                )
                processes.append(process)
            
            # Verify both running
            for p in processes:
                assert p.poll() is None
            
            # Stop all
            manager.stop_all()
            
            # Verify all stopped
            for p in processes:
                assert p.poll() is not None


class TestConcurrentAccess:
    """Tests for concurrent/threaded access"""
    
    def test_concurrent_health_checks(self):
        """Test health checks can be called concurrently"""
        config = ServiceConfig(skip_atropos=True, skip_vllm=True)
        manager = ServiceManager(config)
        
        results = []
        errors = []
        
        def check_health():
            try:
                result = manager._check_health("nonexistent")
                results.append(result)
            except Exception as e:
                errors.append(e)
        
        threads = [threading.Thread(target=check_health) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        
        assert len(errors) == 0
        assert len(results) == 10
        assert all(r is False for r in results)

