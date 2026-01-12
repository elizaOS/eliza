import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TypeVar

from elizaos_browser.types import RetryConfig

logger = logging.getLogger(__name__)

T = TypeVar("T")


DEFAULT_RETRY_CONFIGS = {
    "navigation": RetryConfig(
        max_attempts=3,
        initial_delay_ms=1000,
        max_delay_ms=5000,
        backoff_multiplier=2.0,
    ),
    "action": RetryConfig(
        max_attempts=2,
        initial_delay_ms=500,
        max_delay_ms=2000,
        backoff_multiplier=1.5,
    ),
    "extraction": RetryConfig(
        max_attempts=2,
        initial_delay_ms=500,
        max_delay_ms=3000,
        backoff_multiplier=2.0,
    ),
}


async def retry_with_backoff(
    fn: Callable[[], Awaitable[T]],
    config: RetryConfig,
    operation: str,
    timeout_ms: int | None = None,
) -> T:
    last_error: Exception | None = None
    delay = config.initial_delay_ms / 1000  # Convert to seconds

    for attempt in range(1, config.max_attempts + 1):
        try:
            logger.info(f"Attempting {operation} (attempt {attempt}/{config.max_attempts})")

            if timeout_ms:
                result = await asyncio.wait_for(
                    fn(),
                    timeout=timeout_ms / 1000,
                )
            else:
                result = await fn()

            return result

        except asyncio.TimeoutError as e:
            last_error = e
            logger.warning(f"{operation} timed out (attempt {attempt}/{config.max_attempts})")
        except Exception as e:
            last_error = e
            logger.warning(f"{operation} failed (attempt {attempt}/{config.max_attempts}): {e}")

        if attempt < config.max_attempts:
            logger.info(f"Retrying {operation} in {delay}s...")
            await asyncio.sleep(delay)
            delay = min(delay * config.backoff_multiplier, config.max_delay_ms / 1000)

    logger.error(f"{operation} failed after {config.max_attempts} attempts")
    if last_error:
        raise last_error
    raise RuntimeError(f"{operation} failed after {config.max_attempts} attempts")


async def sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)
