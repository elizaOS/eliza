"""
Service Manager for Local Training Infrastructure

Manages the lifecycle of background services required for local GRPO training:
- Atropos API Server: Handles batch collection and distribution
- vLLM Server: Provides inference during rollouts

Features:
- Automatic startup with health checks
- Graceful shutdown with kill fallback
- Context manager interface for automatic cleanup
- Configurable ports and timeouts
- Process output logging to files

Usage:
    config = ServiceConfig(
        atropos_port=8000,
        vllm_port=9001,
        model_name="Qwen/Qwen2.5-3B-Instruct",
    )
    
    with ServiceManager(config) as services:
        if not services.wait_for_ready():
            raise RuntimeError("Services failed to start")
        # Run training...
"""

import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import IO, Optional

import requests

logger = logging.getLogger(__name__)


class ServiceStatus(Enum):
    """Status of a managed service"""
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    FAILED = "failed"
    STOPPING = "stopping"


@dataclass
class ServiceConfig:
    """Configuration for managed services"""
    
    # Atropos API settings
    atropos_port: int = 8000
    atropos_host: str = "localhost"
    
    # vLLM settings
    vllm_port: int = 9001
    vllm_host: str = "localhost"
    model_name: str = "Qwen/Qwen2.5-3B-Instruct"
    vllm_gpu_memory_utilization: float = 0.85
    vllm_dtype: str = "auto"
    vllm_max_model_len: int = 4096
    
    # Multi-GPU settings (Phase 4)
    tensor_parallel_size: int = 1  # Number of GPUs for tensor parallelism
    use_flash_attention: bool = False  # Enable flash attention for performance
    
    # GPU assignment - separate vLLM and training to avoid OOM conflicts
    # vllm_gpu: Comma-separated GPU IDs for vLLM (e.g., "0" or "0,1" for tensor parallel)
    # training_gpu: GPU ID for training model (e.g., "1" for dedicated training GPU)
    vllm_gpu: Optional[str] = None  # If None, falls back to auto-assignment
    training_gpu: Optional[str] = None  # If None, falls back to auto-assignment
    
    # Timeouts
    startup_timeout: int = 180  # 3 minutes for vLLM to load model
    health_check_interval: float = 2.0
    shutdown_timeout: int = 10
    
    # Logging
    log_dir: str = "./logs/services"
    
    # Skip services (for testing or when already running)
    skip_atropos: bool = False
    skip_vllm: bool = False


@dataclass
class ManagedProcess:
    """A managed subprocess with metadata"""
    name: str
    process: Optional[subprocess.Popen] = None
    status: ServiceStatus = ServiceStatus.STOPPED
    log_file: Optional[Path] = None
    log_handle: Optional[IO] = None
    health_url: Optional[str] = None
    
    @property
    def pid(self) -> Optional[int]:
        return self.process.pid if self.process else None
    
    def close_log(self) -> None:
        if self.log_handle:
            self.log_handle.close()
            self.log_handle = None


class ServiceManager:
    """
    Manages background services for local training.
    
    Provides automatic startup, health checking, and cleanup of:
    - Atropos API server (for GRPO batch distribution)
    - vLLM inference server (for model rollouts)
    """
    
    def __init__(self, config: ServiceConfig):
        self.config = config
        self._processes: dict[str, ManagedProcess] = {}
        self._shutdown_requested = False
        
        # Create log directory
        self._log_dir = Path(config.log_dir)
        self._log_dir.mkdir(parents=True, exist_ok=True)
        
        # Register signal handlers for graceful shutdown
        self._original_sigint = signal.getsignal(signal.SIGINT)
        self._original_sigterm = signal.getsignal(signal.SIGTERM)
        
    def __enter__(self) -> "ServiceManager":
        """Context manager entry - start all services"""
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
        self.start_all()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Context manager exit - stop all services"""
        try:
            self.stop_all()
        finally:
            # Always restore original signal handlers
            signal.signal(signal.SIGINT, self._original_sigint)
            signal.signal(signal.SIGTERM, self._original_sigterm)
    
    def _signal_handler(self, signum: int, frame) -> None:
        """Handle shutdown signals gracefully"""
        if self._shutdown_requested:
            # Force exit on second signal
            logger.warning("Forced shutdown requested")
            sys.exit(1)
        
        logger.info(f"Received signal {signum}, initiating graceful shutdown...")
        self._shutdown_requested = True
        self.stop_all()
        sys.exit(0)
    
    def start_all(self) -> bool:
        """Start all configured services"""
        logger.info("=" * 60)
        logger.info("STARTING TRAINING SERVICES")
        logger.info("=" * 60)
        
        success = True
        
        # Start Atropos API
        if not self.config.skip_atropos:
            if not self._start_atropos():
                logger.error("Failed to start Atropos API server")
                success = False
        else:
            logger.info("Skipping Atropos API (configured to skip)")
        
        # Start vLLM
        if not self.config.skip_vllm and success:
            if not self._start_vllm():
                logger.error("Failed to start vLLM server")
                success = False
        else:
            if self.config.skip_vllm:
                logger.info("Skipping vLLM server (configured to skip)")
        
        return success
    
    def stop_all(self) -> None:
        """Stop all managed services gracefully"""
        logger.info("Stopping all services...")
        
        # Stop in reverse order (vLLM first, then Atropos)
        for name in reversed(list(self._processes.keys())):
            self._stop_process(name)
        
        logger.info("All services stopped")
    
    def wait_for_ready(self, timeout: Optional[int] = None) -> bool:
        """
        Wait for all services to be healthy.
        
        Returns True if all services are ready, False on timeout or failure.
        """
        timeout = timeout or self.config.startup_timeout
        start_time = time.time()
        
        services_to_check = []
        if not self.config.skip_atropos:
            services_to_check.append("atropos")
        if not self.config.skip_vllm:
            services_to_check.append("vllm")
        
        if not services_to_check:
            logger.info("No services to wait for")
            return True
        
        logger.info(f"Waiting for services to be ready (timeout: {timeout}s)...")
        
        ready = {name: False for name in services_to_check}
        
        while time.time() - start_time < timeout:
            if self._shutdown_requested:
                return False
            
            all_ready = True
            for name in services_to_check:
                if ready[name]:
                    continue
                
                if self._check_health(name):
                    ready[name] = True
                    logger.info(f"  ✓ {name} is ready")
                else:
                    all_ready = False
                    
                    # Check if process died
                    proc = self._processes.get(name)
                    if proc and proc.process and proc.process.poll() is not None:
                        logger.error(f"  ✗ {name} process died (exit code: {proc.process.returncode})")
                        return False
            
            if all_ready:
                elapsed = time.time() - start_time
                logger.info(f"All services ready in {elapsed:.1f}s")
                return True
            
            time.sleep(self.config.health_check_interval)
        
        # Timeout - report which services failed
        for name, is_ready in ready.items():
            if not is_ready:
                logger.error(f"  ✗ {name} failed to become ready")
        
        return False
    
    def is_healthy(self, service: str) -> bool:
        """Check if a specific service is healthy"""
        return self._check_health(service)
    
    def get_status(self, service: str) -> ServiceStatus:
        """Get the status of a specific service"""
        proc = self._processes.get(service)
        if not proc:
            return ServiceStatus.STOPPED
        return proc.status
    
    def get_atropos_url(self) -> str:
        """Get the Atropos API URL"""
        return f"http://{self.config.atropos_host}:{self.config.atropos_port}"
    
    def get_vllm_url(self) -> str:
        """Get the vLLM server URL"""
        return f"http://{self.config.vllm_host}:{self.config.vllm_port}"
    
    def _start_atropos(self) -> bool:
        """Start the Atropos API server"""
        host, port = self.config.atropos_host, self.config.atropos_port
        # Atropos doesn't have /health endpoint, use / which returns 200
        health_url = f"http://{host}:{port}/"
        
        logger.info(f"Starting Atropos API server on port {port}...")
        
        if self._port_in_use(host, port):
            logger.warning(f"Port {port} already in use, assuming Atropos is running")
            self._processes["atropos"] = ManagedProcess(
                name="atropos", status=ServiceStatus.RUNNING, health_url=health_url
            )
            return True
        
        log_file = self._log_dir / "atropos.log"
        log_handle = open(log_file, "w")
        
        try:
            process = subprocess.Popen(
                ["run-api", "--port", str(port)],
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                env=os.environ.copy(),
            )
        except Exception as e:
            log_handle.close()
            logger.error(f"Failed to start Atropos: {e}")
            raise
        
        self._processes["atropos"] = ManagedProcess(
            name="atropos",
            process=process,
            status=ServiceStatus.STARTING,
            log_file=log_file,
            log_handle=log_handle,
            health_url=health_url,
        )
        
        logger.info(f"  Atropos started with PID {process.pid}, logs: {log_file}")
        return True
    
    def _start_vllm(self) -> bool:
        """Start the vLLM inference server"""
        host, port = self.config.vllm_host, self.config.vllm_port
        health_url = f"http://{host}:{port}/health"
        cfg = self.config
        
        logger.info(f"Starting vLLM server on port {port}...")
        logger.info(f"  Model: {cfg.model_name}")
        logger.info(f"  GPU Memory: {cfg.vllm_gpu_memory_utilization * 100:.0f}%")
        if cfg.tensor_parallel_size > 1:
            logger.info(f"  Tensor Parallel: {cfg.tensor_parallel_size} GPUs")
        if cfg.use_flash_attention:
            logger.info("  Flash Attention: enabled")
        
        if self._port_in_use(host, port):
            logger.warning(f"Port {port} already in use, assuming vLLM is running")
            self._processes["vllm"] = ManagedProcess(
                name="vllm", status=ServiceStatus.RUNNING, health_url=health_url
            )
            return True
        
        log_file = self._log_dir / "vllm.log"
        log_handle = open(log_file, "w")
        
        cmd = [
            sys.executable, "-m", "vllm.entrypoints.openai.api_server",
            "--model", cfg.model_name,
            "--port", str(port),
            "--dtype", cfg.vllm_dtype,
            "--gpu-memory-utilization", str(cfg.vllm_gpu_memory_utilization),
            "--max-model-len", str(cfg.vllm_max_model_len),
            "--disable-log-requests",
            "--served-model-name", cfg.model_name,
        ]
        
        # Multi-GPU tensor parallelism (Phase 4)
        if cfg.tensor_parallel_size > 1:
            cmd.extend(["--tensor-parallel-size", str(cfg.tensor_parallel_size)])
        
        env = os.environ.copy()
        
        # Set attention backend if flash attention is configured
        if cfg.use_flash_attention:
            env["VLLM_ATTENTION_BACKEND"] = "FLASH_ATTN"
        
        # Set CUDA devices for vLLM based on explicit configuration or tensor parallel size
        if cfg.vllm_gpu:
            # Explicit GPU assignment from profile
            env["CUDA_VISIBLE_DEVICES"] = cfg.vllm_gpu
            logger.info(f"  vLLM GPUs (explicit): {cfg.vllm_gpu}")
        elif cfg.tensor_parallel_size > 1:
            # Auto-assign GPUs for tensor parallelism
            gpu_ids = ",".join(str(i) for i in range(cfg.tensor_parallel_size))
            env["CUDA_VISIBLE_DEVICES"] = gpu_ids
            logger.info(f"  vLLM GPUs (auto tensor parallel): {gpu_ids}")
        else:
            env.setdefault("CUDA_VISIBLE_DEVICES", "0")
            logger.info("  vLLM GPU (default): 0")
        
        try:
            process = subprocess.Popen(cmd, stdout=log_handle, stderr=subprocess.STDOUT, env=env)
        except Exception as e:
            log_handle.close()
            logger.error(f"Failed to start vLLM: {e}")
            raise
        
        self._processes["vllm"] = ManagedProcess(
            name="vllm",
            process=process,
            status=ServiceStatus.STARTING,
            log_file=log_file,
            log_handle=log_handle,
            health_url=health_url,
        )
        
        logger.info(f"  vLLM started with PID {process.pid}, logs: {log_file}")
        return True
    
    def _stop_process(self, name: str) -> None:
        """Stop a specific process gracefully"""
        proc = self._processes.get(name)
        if not proc:
            return
        
        # Close log handle first
        proc.close_log()
        
        if not proc.process or proc.process.poll() is not None:
            proc.status = ServiceStatus.STOPPED
            return
        
        logger.info(f"Stopping {name} (PID: {proc.pid})...")
        proc.status = ServiceStatus.STOPPING
        proc.process.terminate()
        
        # Wait for graceful shutdown
        deadline = time.time() + self.config.shutdown_timeout
        while time.time() < deadline and proc.process.poll() is None:
            time.sleep(0.5)
        
        if proc.process.poll() is None:
            logger.warning(f"  {name} did not stop gracefully, sending SIGKILL")
            proc.process.kill()
            proc.process.wait()
        else:
            logger.info(f"  {name} stopped gracefully")
        
        proc.status = ServiceStatus.STOPPED
    
    def _check_health(self, name: str) -> bool:
        """Check if a service is healthy via its health endpoint"""
        proc = self._processes.get(name)
        if not proc or not proc.health_url:
            return False
        
        try:
            response = requests.get(proc.health_url, timeout=5)
            if response.status_code == 200:
                proc.status = ServiceStatus.RUNNING
                return True
        except requests.exceptions.ConnectionError:
            pass
        except requests.exceptions.Timeout:
            pass
        
        return False
    
    def _port_in_use(self, host: str, port: int) -> bool:
        """
        Check if a port is already in use.
        
        Note: There is an inherent TOCTOU (time-of-check to time-of-use) race condition
        between this check and actually starting the process. If another process grabs
        the port between check and Popen, startup will fail. This is acceptable for our
        use case since we primarily use this to detect already-running services.
        """
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1)
            return sock.connect_ex((host, port)) == 0
    
    def restart_vllm(self, model_path: Optional[str] = None) -> bool:
        """
        Restart vLLM with optionally updated model weights.
        
        Used during training to sync new weights to the inference server.
        """
        logger.info("Restarting vLLM server...")
        
        # Stop existing vLLM
        self._stop_process("vllm")
        
        # Clear CUDA cache
        self._clear_cuda_cache()
        
        # Update model path if provided
        if model_path:
            self.config.model_name = model_path
        
        # Start new vLLM
        if not self._start_vllm():
            return False
        
        # Wait for it to be ready
        start_time = time.time()
        timeout = self.config.startup_timeout
        
        while time.time() - start_time < timeout:
            if self._check_health("vllm"):
                elapsed = time.time() - start_time
                logger.info(f"vLLM restarted successfully in {elapsed:.1f}s")
                return True
            
            # Check if process died
            proc = self._processes.get("vllm")
            if proc and proc.process and proc.process.poll() is not None:
                logger.error(f"vLLM died during restart (exit code: {proc.process.returncode})")
                return False
            
            time.sleep(self.config.health_check_interval)
        
        logger.error("vLLM restart timed out")
        return False
    
    def _clear_cuda_cache(self) -> None:
        """Clear CUDA memory cache if available"""
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
                logger.debug("CUDA cache cleared")
        except ImportError:
            pass


def check_prerequisites() -> list[str]:
    """
    Check that all prerequisites for local training are available.
    
    Returns a list of error messages for missing requirements.
    """
    errors = []
    
    if not shutil.which("run-api"):
        errors.append("Atropos API not found. Install with: pip install atroposlib")
    
    try:
        import vllm  # noqa: F401
    except ImportError:
        errors.append("vLLM not installed. Install with: pip install vllm")
    
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            gpu_mem = torch.cuda.get_device_properties(0).total_memory / 1e9
            logger.info(f"GPU detected: {gpu_name} ({gpu_mem:.1f} GB)")
        else:
            errors.append(
                "CUDA not available. GPU is required for vLLM inference. "
                "For CPU-only training, use --skip-vllm and provide external inference."
            )
    except ImportError:
        errors.append("PyTorch not installed. Install with: pip install torch")
    
    if not os.getenv("DATABASE_URL"):
        errors.append(
            "DATABASE_URL not set. Required for loading training trajectories. "
            "Set with: export DATABASE_URL=postgresql://user:pass@host:5432/dbname"
        )
    
    return errors

