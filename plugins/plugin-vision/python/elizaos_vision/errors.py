from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


class VisionError(Exception):
    def __init__(
        self,
        message: str,
        code: str,
        recoverable: bool = False,
        context: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable
        self.context = context or {}


class CameraError(VisionError):
    def __init__(self, message: str, context: dict[str, Any] | None = None):
        super().__init__(message, "CAMERA_ERROR", True, context)


class ScreenCaptureError(VisionError):
    def __init__(self, message: str, context: dict[str, Any] | None = None):
        super().__init__(message, "SCREEN_CAPTURE_ERROR", True, context)


class ModelInitializationError(VisionError):
    def __init__(self, message: str, model_name: str, context: dict[str, Any] | None = None):
        ctx = context or {}
        ctx["model_name"] = model_name
        super().__init__(message, "MODEL_INIT_ERROR", False, ctx)


class ProcessingError(VisionError):
    def __init__(self, message: str, context: dict[str, Any] | None = None):
        super().__init__(message, "PROCESSING_ERROR", True, context)


class ConfigurationError(VisionError):
    def __init__(self, message: str, context: dict[str, Any] | None = None):
        super().__init__(message, "CONFIG_ERROR", False, context)


class APIError(VisionError):
    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        endpoint: str | None = None,
        context: dict[str, Any] | None = None,
    ):
        ctx = context or {}
        ctx["status_code"] = status_code
        ctx["endpoint"] = endpoint
        super().__init__(message, "API_ERROR", True, ctx)
        self.status_code = status_code
        self.endpoint = endpoint


class RecoveryStrategy(ABC):
    """Abstract recovery strategy"""

    @abstractmethod
    def can_recover(self, error: VisionError) -> bool:
        """Check if this strategy can recover from the error"""
        pass

    @abstractmethod
    async def recover(self, error: VisionError) -> None:
        """Attempt to recover from the error"""
        pass


class ErrorRecoveryManager:
    def __init__(self, max_retries: int = 3):
        self._strategies: dict[str, RecoveryStrategy] = {}
        self._error_counts: dict[str, int] = {}
        self._max_retries = max_retries
        self._register_default_strategies()

    def _register_default_strategies(self) -> None:
        class CameraRecoveryStrategy(RecoveryStrategy):
            def __init__(self, manager: ErrorRecoveryManager):
                self._manager = manager

            def can_recover(self, error: VisionError) -> bool:
                count = self._manager._error_counts.get(error.code, 0)
                return count < self._manager._max_retries

            async def recover(self, error: VisionError) -> None:
                logger.warning(f"[ErrorRecovery] Attempting camera recovery: {error}")
                delay = self._manager._error_counts.get(error.code, 1)
                await asyncio.sleep(delay)
                logger.info("[ErrorRecovery] Camera recovery attempt complete")

        class APIRecoveryStrategy(RecoveryStrategy):
            def __init__(self, manager: ErrorRecoveryManager):
                self._manager = manager

            def can_recover(self, error: VisionError) -> bool:
                if isinstance(error, APIError):
                    if error.status_code and 400 <= error.status_code < 500:
                        return False
                    key = f"{error.code}_{error.endpoint}"
                    count = self._manager._error_counts.get(key, 0)
                    return count < self._manager._max_retries
                return False

            async def recover(self, error: VisionError) -> None:
                if isinstance(error, APIError):
                    logger.warning(f"[ErrorRecovery] API error recovery: {error}")
                    key = f"{error.code}_{error.endpoint}"
                    count = self._manager._error_counts.get(key, 0)
                    delay = min(2**count, 30)
                    await asyncio.sleep(delay)

        class ScreenCaptureRecoveryStrategy(RecoveryStrategy):
            def can_recover(self, _error: VisionError) -> bool:
                return True

            async def recover(self, error: VisionError) -> None:
                logger.warning(f"[ErrorRecovery] Screen capture recovery: {error}")
                await asyncio.sleep(0.5)

        self._strategies["CAMERA_ERROR"] = CameraRecoveryStrategy(self)
        self._strategies["API_ERROR"] = APIRecoveryStrategy(self)
        self._strategies["SCREEN_CAPTURE_ERROR"] = ScreenCaptureRecoveryStrategy()

    def register_strategy(self, error_code: str, strategy: RecoveryStrategy) -> None:
        self._strategies[error_code] = strategy

    async def handle_error(self, error: VisionError) -> bool:
        logger.error(
            f"[ErrorRecovery] Handling {error.__class__.__name__}: {error} {error.context}"
        )

        error_key = error.code + str(error.context.get("endpoint", ""))
        current_count = self._error_counts.get(error_key, 0)
        self._error_counts[error_key] = current_count + 1

        if not error.recoverable:
            logger.error("[ErrorRecovery] Error is not recoverable")
            return False

        strategy = self._strategies.get(error.code)
        if not strategy:
            logger.warning(f"[ErrorRecovery] No recovery strategy for error code: {error.code}")
            return False

        if not strategy.can_recover(error):
            logger.error("[ErrorRecovery] Recovery strategy cannot handle this error")
            return False

        try:
            await strategy.recover(error)
            logger.info("[ErrorRecovery] Recovery successful")
            return True
        except Exception as e:
            logger.error(f"[ErrorRecovery] Recovery failed: {e}")
            return False

    def reset_error_count(self, error_code: str) -> None:
        if error_code in self._error_counts:
            del self._error_counts[error_code]

    def reset_all_counts(self) -> None:
        self._error_counts.clear()


class CircuitBreaker:
    def __init__(self, threshold: int = 5, timeout: float = 60.0, name: str = "unknown"):
        self._threshold = threshold
        self._timeout = timeout
        self._name = name
        self._failures = 0
        self._last_failure_time = 0.0
        self._state: str = "closed"  # closed, open, half-open

    async def execute(self, operation: Callable[[], T]) -> T:
        if self._state == "open":
            if time.time() - self._last_failure_time > self._timeout:
                self._state = "half-open"
                logger.info(f"[CircuitBreaker] {self._name} entering half-open state")
            else:
                raise VisionError(
                    f"Circuit breaker is open for {self._name}",
                    "CIRCUIT_BREAKER_OPEN",
                    True,
                )

        try:
            if asyncio.iscoroutinefunction(operation):
                result = await operation()
            else:
                result = operation()
            self._on_success()
            return result
        except Exception:
            self._on_failure()
            raise

    def _on_success(self) -> None:
        if self._state == "half-open":
            logger.info(f"[CircuitBreaker] {self._name} recovered, closing circuit")
        self._failures = 0
        self._state = "closed"

    def _on_failure(self) -> None:
        self._failures += 1
        self._last_failure_time = time.time()

        if self._failures >= self._threshold:
            self._state = "open"
            logger.error(f"[CircuitBreaker] {self._name} threshold exceeded, opening circuit")

    @property
    def state(self) -> str:
        return self._state

    def reset(self) -> None:
        self._failures = 0
        self._state = "closed"
        logger.info(f"[CircuitBreaker] {self._name} reset")


class VisionErrorHandler:
    _instance: VisionErrorHandler | None = None

    def __new__(cls) -> VisionErrorHandler:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._recovery_manager = ErrorRecoveryManager()
            cls._instance._circuit_breakers: dict[str, CircuitBreaker] = {}
        return cls._instance

    @classmethod
    def get_instance(cls) -> VisionErrorHandler:
        return cls()

    def get_circuit_breaker(
        self, name: str, threshold: int = 5, timeout: float = 60.0
    ) -> CircuitBreaker:
        if name not in self._circuit_breakers:
            self._circuit_breakers[name] = CircuitBreaker(threshold, timeout, name)
        return self._circuit_breakers[name]

    async def handle(self, error: Exception) -> bool:
        if isinstance(error, VisionError):
            return await self._recovery_manager.handle_error(error)
        else:
            vision_error = ProcessingError(str(error), {"original_error": error})
            return await self._recovery_manager.handle_error(vision_error)

    def reset_circuit_breaker(self, name: str) -> None:
        if name in self._circuit_breakers:
            self._circuit_breakers[name].reset()

    def reset_all_circuit_breakers(self) -> None:
        for breaker in self._circuit_breakers.values():
            breaker.reset()
