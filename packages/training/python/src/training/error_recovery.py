"""
Error Recovery and Graceful Degradation for Training Pipeline

Provides utilities for handling failures gracefully:
- Database connection recovery
- Malformed data handling
- Service health monitoring
- Graceful shutdown
- Retry logic with backoff

Philosophy:
- Fail fast for programmer errors
- Recover gracefully from transient errors
- Always log what went wrong
- Never lose training progress silently
"""

import asyncio
import functools
import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, TypeVar, Union

logger = logging.getLogger(__name__)

T = TypeVar("T")


# ============================================================================
# Error Categories
# ============================================================================

class ErrorCategory(Enum):
    """Categories of errors for handling decisions"""
    
    # Transient - retry makes sense
    TRANSIENT = "transient"
    
    # Configuration - fix config and restart
    CONFIGURATION = "configuration"
    
    # Data - skip this item and continue
    DATA_VALIDATION = "data_validation"
    
    # Infrastructure - external service down
    INFRASTRUCTURE = "infrastructure"
    
    # Fatal - cannot continue
    FATAL = "fatal"


class TrainingError(Exception):
    """
    Structured training error for handling decisions.
    
    Inherits from Exception so it can be raised and caught properly.
    """
    
    def __init__(
        self,
        category: ErrorCategory,
        message: str,
        component: str,
        recoverable: bool,
        details: Optional[Dict[str, Any]] = None,
        original_exception: Optional[Exception] = None,
    ):
        super().__init__(message)
        self.category = category
        self.message = message
        self.component = component
        self.recoverable = recoverable
        self.details = details or {}
        self.original_exception = original_exception
    
    def __str__(self) -> str:
        return f"[{self.category.value}] {self.component}: {self.message}"


# ============================================================================
# Error Classification
# ============================================================================

def classify_error(exception: Exception) -> ErrorCategory:
    """
    Classify an exception into an error category for handling decisions.
    
    This helps decide whether to retry, skip, or abort.
    """
    error_str = str(exception).lower()
    exception_type = type(exception).__name__
    
    # Connection errors - transient
    if any(x in exception_type for x in ["Connection", "Timeout", "Network"]):
        return ErrorCategory.TRANSIENT
    
    if any(x in error_str for x in [
        "connection refused",
        "connection reset",
        "timeout",
        "temporary failure",
        "service unavailable",
    ]):
        return ErrorCategory.TRANSIENT
    
    # Configuration errors
    if any(x in error_str for x in [
        "not set",
        "not configured",
        "invalid config",
        "missing required",
    ]):
        return ErrorCategory.CONFIGURATION
    
    # Data validation errors
    if any(x in error_str for x in [
        "json",
        "parse",
        "decode",
        "invalid data",
        "schema",
        "validation",
    ]):
        return ErrorCategory.DATA_VALIDATION
    
    # Infrastructure errors
    if any(x in error_str for x in [
        "database",
        "redis",
        "cuda",
        "gpu",
        "out of memory",
    ]):
        return ErrorCategory.INFRASTRUCTURE
    
    # Default to fatal for unknown errors
    return ErrorCategory.FATAL


def is_recoverable(exception: Exception) -> bool:
    """Check if an error is recoverable (worth retrying)"""
    category = classify_error(exception)
    return category in (ErrorCategory.TRANSIENT, ErrorCategory.DATA_VALIDATION)


# ============================================================================
# Retry Logic
# ============================================================================

def with_retry(
    max_attempts: int = 3,
    initial_delay: float = 1.0,
    max_delay: float = 30.0,
    backoff_factor: float = 2.0,
    retryable_exceptions: tuple = (Exception,),
) -> Callable:
    """
    Decorator for retry with exponential backoff.
    
    Args:
        max_attempts: Maximum number of attempts
        initial_delay: Initial delay between retries (seconds)
        max_delay: Maximum delay between retries (seconds)
        backoff_factor: Multiplier for delay after each attempt
        retryable_exceptions: Tuple of exceptions that trigger retry
    """
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args, **kwargs) -> T:
            last_exception = None
            delay = initial_delay
            
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except retryable_exceptions as e:
                    last_exception = e
                    
                    if not is_recoverable(e):
                        logger.error(f"{func.__name__} failed with non-recoverable error: {e}")
                        raise
                    
                    if attempt < max_attempts:
                        logger.warning(
                            f"{func.__name__} failed (attempt {attempt}/{max_attempts}), "
                            f"retrying in {delay:.1f}s: {e}"
                        )
                        time.sleep(delay)
                        delay = min(delay * backoff_factor, max_delay)
                    else:
                        logger.error(
                            f"{func.__name__} failed after {max_attempts} attempts: {e}"
                        )
            
            if last_exception:
                raise last_exception
            raise RuntimeError(f"{func.__name__} failed with no exception captured")
        
        return wrapper
    return decorator


def with_retry_async(
    max_attempts: int = 3,
    initial_delay: float = 1.0,
    max_delay: float = 30.0,
    backoff_factor: float = 2.0,
    retryable_exceptions: tuple = (Exception,),
) -> Callable:
    """Async version of retry decorator"""
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs) -> T:
            last_exception = None
            delay = initial_delay
            
            for attempt in range(1, max_attempts + 1):
                try:
                    return await func(*args, **kwargs)
                except retryable_exceptions as e:
                    last_exception = e
                    
                    if not is_recoverable(e):
                        logger.error(f"{func.__name__} failed with non-recoverable error: {e}")
                        raise
                    
                    if attempt < max_attempts:
                        logger.warning(
                            f"{func.__name__} failed (attempt {attempt}/{max_attempts}), "
                            f"retrying in {delay:.1f}s: {e}"
                        )
                        await asyncio.sleep(delay)
                        delay = min(delay * backoff_factor, max_delay)
                    else:
                        logger.error(
                            f"{func.__name__} failed after {max_attempts} attempts: {e}"
                        )
            
            if last_exception:
                raise last_exception
            raise RuntimeError(f"{func.__name__} failed with no exception captured")
        
        return wrapper
    return decorator


# ============================================================================
# Data Recovery
# ============================================================================

@dataclass
class RecoveryResult:
    """Result of data recovery attempt"""
    success: bool
    data: Any = None
    fallback_used: bool = False
    errors: List[str] = field(default_factory=list)


def recover_json_parse(
    json_str: str,
    fallback: Any = None,
) -> RecoveryResult:
    """
    Attempt to parse JSON with fallback on failure.
    
    Args:
        json_str: JSON string to parse
        fallback: Value to return on parse failure
        
    Returns:
        RecoveryResult with parsed data or fallback
    """
    if not json_str:
        return RecoveryResult(
            success=True,
            data=fallback if fallback is not None else [],
            fallback_used=True,
        )
    
    try:
        data = json.loads(json_str)
        return RecoveryResult(success=True, data=data)
    except json.JSONDecodeError as e:
        return RecoveryResult(
            success=False,
            data=fallback if fallback is not None else [],
            fallback_used=True,
            errors=[f"JSON parse error: {e}"],
        )


def recover_trajectory_archetype(
    trajectory: Dict[str, Any],
    default: str = "default",
) -> str:
    """
    Extract archetype from trajectory with fallback logic.
    
    Tries:
    1. trajectory.archetype
    2. First step's action.parameters.archetype
    3. First step's action.result.archetype
    4. default
    
    Returns:
        Extracted or default archetype
    """
    # Try trajectory level
    archetype = trajectory.get("archetype")
    if archetype:
        return archetype
    
    # Try steps
    steps_json = trajectory.get("stepsJson", trajectory.get("steps_json", "[]"))
    result = recover_json_parse(steps_json, [])
    
    if result.success and result.data:
        for step in result.data:
            action = step.get("action", {})
            
            # Try parameters
            params_arch = action.get("parameters", {}).get("archetype")
            if params_arch:
                return params_arch
            
            # Try result
            result_arch = action.get("result", {}).get("archetype")
            if result_arch:
                return result_arch
    
    return default


def filter_valid_trajectories(
    trajectories: List[Dict[str, Any]],
    min_steps: int = 1,
    require_pnl: bool = False,
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Filter trajectories, separating valid from invalid.
    
    Returns:
        Tuple of (valid_trajectories, invalid_trajectories)
    """
    valid = []
    invalid = []
    
    for traj in trajectories:
        errors = []
        
        # Check required fields
        if not traj.get("trajectoryId") and not traj.get("trajectory_id"):
            errors.append("missing trajectoryId")
        
        # Check steps
        steps_json = traj.get("stepsJson", traj.get("steps_json", "[]"))
        steps_result = recover_json_parse(steps_json, [])
        
        if not steps_result.success:
            errors.append(f"invalid stepsJson: {steps_result.errors}")
        elif len(steps_result.data) < min_steps:
            errors.append(f"insufficient steps: {len(steps_result.data)} < {min_steps}")
        
        # Check PnL if required
        if require_pnl:
            pnl = traj.get("finalPnL", traj.get("final_pnl"))
            if pnl is None:
                errors.append("missing finalPnL")
        
        if errors:
            traj["_validation_errors"] = errors
            invalid.append(traj)
        else:
            valid.append(traj)
    
    return valid, invalid


# ============================================================================
# Database Recovery
# ============================================================================

class DatabaseConnectionManager:
    """
    Manages database connection with automatic recovery.
    
    Handles:
    - Connection creation with retry
    - Health checking
    - Automatic reconnection on failure
    - Connection pooling
    """
    
    def __init__(
        self,
        database_url: str,
        pool_size: int = 5,
        max_retries: int = 3,
    ):
        self.database_url = database_url
        self.pool_size = pool_size
        self.max_retries = max_retries
        self._pool = None
        self._last_health_check = 0.0
        self._health_check_interval = 30.0  # seconds
    
    async def get_pool(self):
        """Get database pool, creating if necessary"""
        if self._pool is None:
            await self._create_pool()
        return self._pool
    
    @with_retry_async(max_attempts=3, initial_delay=2.0)
    async def _create_pool(self):
        """Create database connection pool with retry"""
        import asyncpg
        
        logger.info(f"Creating database connection pool (size={self.pool_size})...")
        self._pool = await asyncpg.create_pool(
            self.database_url,
            min_size=2,
            max_size=self.pool_size,
            command_timeout=60,
        )
        logger.info("Database connection pool created")
    
    async def health_check(self) -> bool:
        """Check if database connection is healthy"""
        now = time.time()
        
        # Skip if checked recently
        if now - self._last_health_check < self._health_check_interval:
            return True
        
        self._last_health_check = now
        
        if self._pool is None:
            return False
        
        try:
            async with self._pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            return True
        except Exception as e:
            logger.warning(f"Database health check failed: {e}")
            return False
    
    async def close(self):
        """Close database pool"""
        if self._pool:
            await self._pool.close()
            self._pool = None
            logger.info("Database connection pool closed")


# ============================================================================
# Graceful Shutdown
# ============================================================================

class GracefulShutdown:
    """
    Manages graceful shutdown of training pipeline.
    
    Features:
    - Signal handling (SIGINT, SIGTERM)
    - Checkpoint saving before exit
    - Resource cleanup
    - Timeout for forced exit
    """
    
    def __init__(
        self,
        shutdown_timeout: float = 30.0,
        checkpoint_callback: Optional[Callable] = None,
    ):
        self.shutdown_timeout = shutdown_timeout
        self.checkpoint_callback = checkpoint_callback
        self._shutdown_requested = False
        self._original_handlers: Dict[int, Any] = {}
    
    @property
    def shutdown_requested(self) -> bool:
        """Check if shutdown has been requested"""
        return self._shutdown_requested
    
    def install_handlers(self):
        """Install signal handlers for graceful shutdown"""
        for sig in (signal.SIGINT, signal.SIGTERM):
            self._original_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, self._handle_signal)
        
        logger.debug("Graceful shutdown handlers installed")
    
    def restore_handlers(self):
        """Restore original signal handlers"""
        for sig, handler in self._original_handlers.items():
            signal.signal(sig, handler)
        
        self._original_handlers.clear()
        logger.debug("Original signal handlers restored")
    
    def _handle_signal(self, signum: int, frame):
        """Handle shutdown signal"""
        if self._shutdown_requested:
            logger.warning("Forced shutdown requested - exiting immediately")
            sys.exit(1)
        
        sig_name = signal.Signals(signum).name
        logger.info(f"Received {sig_name} - initiating graceful shutdown...")
        self._shutdown_requested = True
        
        # Save checkpoint if callback provided
        if self.checkpoint_callback:
            logger.info("Saving checkpoint before shutdown...")
            try:
                self.checkpoint_callback()
                logger.info("Checkpoint saved successfully")
            except Exception as e:
                logger.error(f"Failed to save checkpoint: {e}")
    
    def __enter__(self):
        self.install_handlers()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.restore_handlers()


# ============================================================================
# Progress Tracking
# ============================================================================

@dataclass
class TrainingProgress:
    """Tracks training progress for recovery purposes"""
    
    # Maximum errors to keep in memory (prevents unbounded growth during long runs)
    MAX_ERRORS_IN_MEMORY: int = 200
    
    current_step: int = 0
    total_steps: int = 0
    trajectories_processed: int = 0
    trajectories_skipped: int = 0
    last_checkpoint_step: int = 0
    errors_encountered: List[str] = field(default_factory=list)
    start_time: float = field(default_factory=time.time)
    total_errors_count: int = 0  # Track total even when list is truncated
    
    def add_error(self, error: str) -> None:
        """Add an error, truncating old errors if list grows too large"""
        self.errors_encountered.append(error)
        self.total_errors_count += 1
        # Keep only the most recent errors
        if len(self.errors_encountered) > self.MAX_ERRORS_IN_MEMORY:
            self.errors_encountered = self.errors_encountered[-self.MAX_ERRORS_IN_MEMORY:]
    
    @property
    def elapsed_time(self) -> float:
        """Seconds since training started"""
        return time.time() - self.start_time
    
    @property
    def progress_pct(self) -> float:
        """Progress percentage (0-100)"""
        if self.total_steps == 0:
            return 0.0
        return (self.current_step / self.total_steps) * 100
    
    def to_checkpoint(self) -> Dict[str, Any]:
        """Convert to checkpoint-compatible dict"""
        return {
            "current_step": self.current_step,
            "total_steps": self.total_steps,
            "trajectories_processed": self.trajectories_processed,
            "trajectories_skipped": self.trajectories_skipped,
            "last_checkpoint_step": self.last_checkpoint_step,
            "errors_encountered": self.errors_encountered[-100:],  # Keep last 100 in checkpoint
            "total_errors_count": self.total_errors_count,
            "elapsed_time": self.elapsed_time,
        }
    
    @classmethod
    def from_checkpoint(cls, data: Dict[str, Any]) -> "TrainingProgress":
        """Restore from checkpoint"""
        progress = cls(
            current_step=data.get("current_step", 0),
            total_steps=data.get("total_steps", 0),
            trajectories_processed=data.get("trajectories_processed", 0),
            trajectories_skipped=data.get("trajectories_skipped", 0),
            last_checkpoint_step=data.get("last_checkpoint_step", 0),
            errors_encountered=data.get("errors_encountered", []),
            total_errors_count=data.get("total_errors_count", len(data.get("errors_encountered", []))),
        )
        return progress
    
    def log_status(self):
        """Log current training status"""
        logger.info(
            f"Training Progress: Step {self.current_step}/{self.total_steps} "
            f"({self.progress_pct:.1f}%) | "
            f"Trajectories: {self.trajectories_processed} processed, "
            f"{self.trajectories_skipped} skipped | "
            f"Errors: {self.total_errors_count} | "
            f"Elapsed: {self.elapsed_time:.0f}s"
        )


# ============================================================================
# Utility Functions
# ============================================================================

def safe_divide(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Safe division that returns default on zero denominator"""
    if denominator == 0:
        return default
    return numerator / denominator


def clamp(value: float, min_val: float, max_val: float) -> float:
    """Clamp value to range [min_val, max_val]"""
    return max(min_val, min(max_val, value))


def require_env(name: str) -> str:
    """Get required environment variable or raise clear error"""
    value = os.getenv(name)
    if not value:
        raise TrainingError(
            category=ErrorCategory.CONFIGURATION,
            message=f"Required environment variable '{name}' is not set",
            component="environment",
            recoverable=False,
        )
    return value


def get_env_or_default(name: str, default: str) -> str:
    """Get environment variable with default value"""
    return os.getenv(name, default)

