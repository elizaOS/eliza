#!/usr/bin/env python3
"""
Adaptive Memory Cleanup System for Kokoro Language Model Training
Provides intelligent memory management based on device type and memory pressure
"""

import torch
import time
import logging
import gc
import psutil
from typing import Dict, Any, Optional
from dataclasses import dataclass
from enum import Enum

from .device_type import DeviceType

logger = logging.getLogger(__name__)


class MemoryPressureLevel(Enum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class MemoryThresholds:
    """Memory thresholds for different pressure levels (as percentage of total memory)"""
    low_threshold: float = 0.6      # Below 60% usage
    moderate_threshold: float = 0.75 # 60-75% usage
    high_threshold: float = 0.85     # 75-85% usage
    critical_threshold: float = 0.95 # Above 85% usage


@dataclass
class CleanupStrategy:
    """Cleanup strategy configuration for different pressure levels"""
    # How often to check memory (in batches)
    check_interval: int
    # Whether to run garbage collection
    run_gc: bool
    # Whether to clear device cache
    clear_cache: bool
    # Whether to force synchronization
    force_sync: bool
    # Delay after cleanup (seconds)
    cleanup_delay: float
    # Whether to log detailed info
    verbose_logging: bool


class AdaptiveMemoryManager:
    """
    Adaptive memory cleanup system that adjusts behavior based on:
    1. Device type (CUDA, MPS, CPU)
    2. Current memory pressure
    3. Historical memory patterns
    4. Training performance impact
    """

    def __init__(self, device: torch.device, config: Optional[Any] = None):
        self.device = device
        self.device_type = DeviceType(device.type)
        self.config = config

        # Memory tracking
        self.memory_history = []
        self.cleanup_history = []
        self.last_cleanup_time = 0
        self.cleanup_count = 0
        self.batch_count = 0

        # Device-specific configuration
        self.thresholds = self._get_device_thresholds()
        self.strategies = self._get_device_strategies()
        self.total_memory = self._get_total_memory()

        # Adaptive parameters
        self.current_pressure = MemoryPressureLevel.LOW
        self.consecutive_high_pressure = 0
        self.memory_trend = 0.0  # Positive = increasing, negative = decreasing

        # Performance tracking
        self.cleanup_overhead_ms = 0.0
        self.total_cleanup_time = 0.0

        logger.info(f"Initialized adaptive memory manager for {self.device_type.value}")
        logger.info(f"Total memory: {self.total_memory:.1f} MB")
        logger.info(f"Thresholds - Low: {self.thresholds.low_threshold*100:.1f}%, "
                   f"Moderate: {self.thresholds.moderate_threshold*100:.1f}%, "
                   f"High: {self.thresholds.high_threshold*100:.1f}%, "
                   f"Critical: {self.thresholds.critical_threshold*100:.1f}%")

    def _get_device_thresholds(self) -> MemoryThresholds:
        """Get device-specific memory thresholds"""
        if self.device_type == DeviceType.CUDA:
            # CUDA has better memory management, can use higher thresholds
            return MemoryThresholds(
                low_threshold=0.65,
                moderate_threshold=0.78,
                high_threshold=0.88,
                critical_threshold=0.95
            )
        elif self.device_type == DeviceType.MPS:
            # MPS is more conservative due to unified memory architecture
            return MemoryThresholds(
                low_threshold=0.55,
                moderate_threshold=0.70,
                high_threshold=0.82,
                critical_threshold=0.92
            )
        else:  # CPU
            # CPU uses system RAM, typically more available
            return MemoryThresholds(
                low_threshold=0.70,
                moderate_threshold=0.80,
                high_threshold=0.90,
                critical_threshold=0.95
            )

    def _get_device_strategies(self) -> Dict[MemoryPressureLevel, CleanupStrategy]:
        """Get device-specific cleanup strategies"""
        if self.device_type == DeviceType.CUDA:
            return {
                MemoryPressureLevel.LOW: CleanupStrategy(
                    check_interval=200, run_gc=False, clear_cache=False,
                    force_sync=False, cleanup_delay=0.0, verbose_logging=False
                ),
                MemoryPressureLevel.MODERATE: CleanupStrategy(
                    check_interval=100, run_gc=False, clear_cache=True,
                    force_sync=False, cleanup_delay=0.01, verbose_logging=False
                ),
                MemoryPressureLevel.HIGH: CleanupStrategy(
                    check_interval=50, run_gc=True, clear_cache=True,
                    force_sync=True, cleanup_delay=0.02, verbose_logging=True
                ),
                MemoryPressureLevel.CRITICAL: CleanupStrategy(
                    check_interval=10, run_gc=True, clear_cache=True,
                    force_sync=True, cleanup_delay=0.05, verbose_logging=True
                )
            }
        elif self.device_type == DeviceType.MPS:
            return {
                MemoryPressureLevel.LOW: CleanupStrategy(
                    check_interval=150, run_gc=False, clear_cache=False,
                    force_sync=False, cleanup_delay=0.0, verbose_logging=False
                ),
                MemoryPressureLevel.MODERATE: CleanupStrategy(
                    check_interval=75, run_gc=True, clear_cache=True,
                    force_sync=False, cleanup_delay=0.02, verbose_logging=False
                ),
                MemoryPressureLevel.HIGH: CleanupStrategy(
                    check_interval=30, run_gc=True, clear_cache=True,
                    force_sync=True, cleanup_delay=0.05, verbose_logging=True
                ),
                MemoryPressureLevel.CRITICAL: CleanupStrategy(
                    check_interval=5, run_gc=True, clear_cache=True,
                    force_sync=True, cleanup_delay=0.1, verbose_logging=True
                )
            }
        else:  # CPU
            return {
                MemoryPressureLevel.LOW: CleanupStrategy(
                    check_interval=300, run_gc=False, clear_cache=False,
                    force_sync=False, cleanup_delay=0.0, verbose_logging=False
                ),
                MemoryPressureLevel.MODERATE: CleanupStrategy(
                    check_interval=150, run_gc=True, clear_cache=False,
                    force_sync=False, cleanup_delay=0.01, verbose_logging=False
                ),
                MemoryPressureLevel.HIGH: CleanupStrategy(
                    check_interval=75, run_gc=True, clear_cache=False,
                    force_sync=False, cleanup_delay=0.02, verbose_logging=True
                ),
                MemoryPressureLevel.CRITICAL: CleanupStrategy(
                    check_interval=25, run_gc=True, clear_cache=False,
                    force_sync=False, cleanup_delay=0.05, verbose_logging=True
                )
            }

    def _get_total_memory(self) -> float:
        """Get total available memory in MB"""
        if self.device_type == DeviceType.CUDA:
            return torch.cuda.get_device_properties(self.device).total_memory / 1024**2
        elif self.device_type == DeviceType.MPS:
            # Estimate for Apple Silicon (could be made configurable)
            try:
                # Try to get a better estimate by allocating and measuring
                test_tensor = torch.randn(1000, 1000, device=self.device)
                allocated = torch.mps.current_allocated_memory() / 1024**2
                del test_tensor
                torch.mps.empty_cache()
                # Estimate total as 8x the small allocation (very rough)
                return max(8192, allocated * 8000)  # Minimum 8GB estimate
            except:
                return 8192  # Default 8GB estimate for Apple Silicon
        else:  # CPU
            return psutil.virtual_memory().total / 1024**2

    def get_current_memory_stats(self) -> Dict[str, float]:
        """Get current memory statistics"""
        if self.device_type == DeviceType.CUDA:
            current = torch.cuda.memory_allocated(self.device) / 1024**2
            reserved = torch.cuda.memory_reserved(self.device) / 1024**2
            peak = torch.cuda.max_memory_allocated(self.device) / 1024**2
        elif self.device_type == DeviceType.MPS:
            try:
                current = torch.mps.current_allocated_memory() / 1024**2
                reserved = current  # MPS doesn't separate reserved
                peak = current      # MPS doesn't track peak separately
            except:
                current = reserved = peak = 0.0
        else:  # CPU
            memory = psutil.virtual_memory()
            current = (memory.total - memory.available) / 1024**2
            reserved = current
            peak = current

        return {
            'current_mb': current,
            'reserved_mb': reserved,
            'peak_mb': peak,
            'total_mb': self.total_memory,
            'usage_percent': (current / self.total_memory) * 100 if self.total_memory > 0 else 0
        }

    def _assess_memory_pressure(self, memory_stats: Dict[str, float]) -> MemoryPressureLevel:
        """Assess current memory pressure level"""
        usage_percent = memory_stats['usage_percent'] / 100

        if usage_percent >= self.thresholds.critical_threshold:
            return MemoryPressureLevel.CRITICAL
        elif usage_percent >= self.thresholds.high_threshold:
            return MemoryPressureLevel.HIGH
        elif usage_percent >= self.thresholds.moderate_threshold:
            return MemoryPressureLevel.MODERATE
        else:
            return MemoryPressureLevel.LOW

    def _update_memory_trend(self, current_usage: float):
        """Update memory usage trend"""
        self.memory_history.append({
            'batch': self.batch_count,
            'usage_percent': current_usage,
            'timestamp': time.time()
        })

        # Keep only recent history (last 50 measurements)
        if len(self.memory_history) > 50:
            self.memory_history.pop(0)

        # Calculate trend over last 10 measurements
        if len(self.memory_history) >= 10:
            recent = self.memory_history[-10:]
            old_avg = sum(m['usage_percent'] for m in recent[:5]) / 5
            new_avg = sum(m['usage_percent'] for m in recent[5:]) / 5
            self.memory_trend = new_avg - old_avg

    def _perform_cleanup(self, strategy: CleanupStrategy, memory_stats: Dict[str, float]) -> float:
        """Perform cleanup according to strategy and return cleanup time"""
        start_time = time.time()

        if strategy.force_sync:
            if self.device_type == DeviceType.CUDA:
                torch.cuda.synchronize(self.device)
            elif self.device_type == DeviceType.MPS:
                torch.mps.synchronize()

        if strategy.run_gc:
            gc.collect()

        if strategy.clear_cache:
            if self.device_type == DeviceType.CUDA:
                torch.cuda.empty_cache()
            elif self.device_type == DeviceType.MPS:
                torch.mps.empty_cache()

        if strategy.cleanup_delay > 0:
            time.sleep(strategy.cleanup_delay)

        cleanup_time = time.time() - start_time

        # Record cleanup event
        self.cleanup_history.append({
            'batch': self.batch_count,
            'pressure_level': self.current_pressure.value,
            'cleanup_time_ms': cleanup_time * 1000,
            'memory_before_mb': memory_stats['current_mb'],
            'timestamp': time.time()
        })

        # Update statistics
        self.cleanup_count += 1
        self.total_cleanup_time += cleanup_time
        self.cleanup_overhead_ms = cleanup_time * 1000
        self.last_cleanup_time = time.time()

        return cleanup_time

    def should_cleanup(self) -> bool:
        """Determine if cleanup should be performed based on current strategy"""
        strategy = self.strategies[self.current_pressure]

        # Check if enough batches have passed
        if self.batch_count % strategy.check_interval != 0:
            return False

        # Always cleanup on critical pressure
        if self.current_pressure == MemoryPressureLevel.CRITICAL:
            return True

        # For high pressure, cleanup more aggressively if trend is increasing
        if self.current_pressure == MemoryPressureLevel.HIGH:
            return True

        # For moderate pressure, cleanup if memory trend is increasing significantly
        if self.current_pressure == MemoryPressureLevel.MODERATE and self.memory_trend > 2.0:
            return True

        # For low pressure, occasional cleanup
        if self.current_pressure == MemoryPressureLevel.LOW:
            return self.batch_count % (strategy.check_interval * 2) == 0

        return False

    def adaptive_cleanup(self, batch_idx: int, force: bool = False) -> Dict[str, Any]:
        """
        Perform adaptive memory cleanup based on current conditions

        Args:
            batch_idx: Current batch index
            force: Force cleanup regardless of strategy

        Returns:
            Dictionary with cleanup results and statistics
        """
        self.batch_count = batch_idx

        # Get current memory statistics
        memory_stats = self.get_current_memory_stats()

        # Assess memory pressure
        old_pressure = self.current_pressure
        self.current_pressure = self._assess_memory_pressure(memory_stats)

        # Update memory trend
        self._update_memory_trend(memory_stats['usage_percent'])

        # Track consecutive high pressure
        if self.current_pressure in [MemoryPressureLevel.HIGH, MemoryPressureLevel.CRITICAL]:
            self.consecutive_high_pressure += 1
        else:
            self.consecutive_high_pressure = 0

        # Determine if cleanup is needed
        should_cleanup = force or self.should_cleanup()

        result = {
            'cleaned': False,
            'cleanup_time_ms': 0.0,
            'memory_before': memory_stats.copy(),
            'memory_after': memory_stats.copy(),
            'pressure_level': self.current_pressure.value,
            'pressure_changed': old_pressure != self.current_pressure,
            'memory_trend': self.memory_trend,
            'consecutive_high_pressure': self.consecutive_high_pressure
        }

        if should_cleanup:
            strategy = self.strategies[self.current_pressure]

            if strategy.verbose_logging:
                logger.info(f"Performing {self.current_pressure.value} pressure cleanup at batch {batch_idx}")
                logger.info(f"Memory usage: {memory_stats['current_mb']:.1f}/{memory_stats['total_mb']:.1f} MB "
                           f"({memory_stats['usage_percent']:.1f}%)")

            # Perform cleanup
            cleanup_time = self._perform_cleanup(strategy, memory_stats)

            # Get memory stats after cleanup
            memory_after = self.get_current_memory_stats()
            memory_freed = memory_stats['current_mb'] - memory_after['current_mb']

            result.update({
                'cleaned': True,
                'cleanup_time_ms': cleanup_time * 1000,
                'memory_after': memory_after,
                'memory_freed_mb': memory_freed
            })

            if strategy.verbose_logging:
                logger.info(f"Cleanup completed in {cleanup_time*1000:.1f}ms, "
                           f"freed {memory_freed:.1f}MB")

        return result

    def emergency_cleanup(self) -> Dict[str, Any]:
        """
        Perform emergency cleanup when OOM is imminent
        Uses most aggressive cleanup strategy regardless of current pressure level
        """
        logger.warning(f"Emergency cleanup triggered on {self.device_type.value}")

        start_time = time.time()
        memory_before = self.get_current_memory_stats()

        # Force synchronization
        if self.device_type == DeviceType.CUDA:
            torch.cuda.synchronize(self.device)
        elif self.device_type == DeviceType.MPS:
            torch.mps.synchronize()

        # Aggressive garbage collection
        gc.collect()
        gc.collect()  # Second call often frees more

        # Clear all caches
        if self.device_type == DeviceType.CUDA:
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats(self.device)
        elif self.device_type == DeviceType.MPS:
            torch.mps.empty_cache()

        # Additional wait for MPS
        if self.device_type == DeviceType.MPS:
            time.sleep(0.1)

        cleanup_time = time.time() - start_time
        memory_after = self.get_current_memory_stats()
        memory_freed = memory_before['current_mb'] - memory_after['current_mb']

        result = {
            'cleanup_time_ms': cleanup_time * 1000,
            'memory_before': memory_before,
            'memory_after': memory_after,
            'memory_freed_mb': memory_freed,
            'success': memory_freed > 0
        }

        logger.warning(f"Emergency cleanup completed: freed {memory_freed:.1f}MB in {cleanup_time*1000:.1f}ms")

        return result

    def get_memory_report(self) -> Dict[str, Any]:
        """Get comprehensive memory management statistics"""
        total_batches = max(1, self.batch_count)

        stats = {
            'device_type': self.device_type.value,
            'total_batches': total_batches,
            'cleanup_count': self.cleanup_count,
            'cleanup_frequency': self.cleanup_count / total_batches,
            'total_cleanup_time_ms': self.total_cleanup_time * 1000,
            'avg_cleanup_time_ms': (self.total_cleanup_time / max(1, self.cleanup_count)) * 1000,
            'cleanup_overhead_percent': (self.total_cleanup_time / max(1, total_batches * 0.1)) * 100,
            'current_pressure': self.current_pressure.value,
            'memory_trend': self.memory_trend,
            'consecutive_high_pressure': self.consecutive_high_pressure
        }

        # Memory statistics
        if self.memory_history:
            recent_memory = [m['usage_percent'] for m in self.memory_history[-10:]]
            stats.update({
                'current_memory_usage_percent': recent_memory[-1] if recent_memory else 0,
                'avg_memory_usage_percent': sum(recent_memory) / len(recent_memory),
                'max_memory_usage_percent': max(recent_memory),
                'min_memory_usage_percent': min(recent_memory)
            })

        return stats
