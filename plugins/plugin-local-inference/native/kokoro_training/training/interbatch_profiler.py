import statistics
import time

from typing import Dict, Any, List
from .config_english import EnglishTrainingConfig as TrainingConfig

class InterbatchProfiler:
    """Profiler for monitoring time between batches and data loading performance"""

    def __init__(self, config: TrainingConfig):
        self.config = config
        self.reset()

    def reset(self):
        """Reset all profiling statistics"""
        self.batch_times = []
        self.interbatch_times = []
        self.data_loading_times = []
        self.forward_pass_times = []
        self.backward_pass_times = []
        self.total_batch_times = []

        self.last_batch_end_time = None
        self.current_batch_start_time = None
        self.data_load_start_time = None
        self.forward_start_time = None
        self.backward_start_time = None

        self.batch_count = 0
        self.total_samples_processed = 0

    def start_batch(self):
        """Mark the start of a new batch"""
        current_time = time.time()
        self.current_batch_start_time = current_time

        # Calculate interbatch time (time between end of last batch and start of current batch)
        if self.last_batch_end_time is not None:
            interbatch_time = current_time - self.last_batch_end_time
            self.interbatch_times.append(interbatch_time)

    def start_data_loading(self):
        """Mark the start of data loading phase"""
        self.data_load_start_time = time.time()

    def end_data_loading(self):
        """Mark the end of data loading phase"""
        if self.data_load_start_time is not None:
            data_load_time = time.time() - self.data_load_start_time
            self.data_loading_times.append(data_load_time)

    def start_forward_pass(self):
        """Mark the start of forward pass"""
        self.forward_start_time = time.time()

    def end_forward_pass(self):
        """Mark the end of forward pass"""
        if self.forward_start_time is not None:
            forward_time = time.time() - self.forward_start_time
            self.forward_pass_times.append(forward_time)

    def start_backward_pass(self):
        """Mark the start of backward pass"""
        self.backward_start_time = time.time()

    def end_backward_pass(self):
        """Mark the end of backward pass"""
        if self.backward_start_time is not None:
            backward_time = time.time() - self.backward_start_time
            self.backward_pass_times.append(backward_time)

    def end_batch(self, batch_size: int = 1):
        """Mark the end of a batch"""
        current_time = time.time()
        self.last_batch_end_time = current_time

        if self.current_batch_start_time is not None:
            total_batch_time = current_time - self.current_batch_start_time
            self.total_batch_times.append(total_batch_time)

        self.batch_count += 1
        self.total_samples_processed += batch_size

    def get_statistics(self) -> Dict[str, Any]:
        """Get comprehensive profiling statistics"""
        stats = {}

        # Helper function to calculate stats for a list of times
        def calc_stats(times: List[float], name: str):
            if not times:
                return {f"{name}_count": 0}
            return {
                f"{name}_count": len(times),
                f"{name}_mean_ms": statistics.mean(times) * 1000,
                f"{name}_median_ms": statistics.median(times) * 1000,
                f"{name}_std_ms": statistics.stdev(times) * 1000 if len(times) > 1 else 0,
                f"{name}_min_ms": min(times) * 1000,
                f"{name}_max_ms": max(times) * 1000,
                f"{name}_total_s": sum(times)
            }

        # Calculate statistics for each phase
        stats.update(calc_stats(self.interbatch_times, "interbatch"))
        stats.update(calc_stats(self.data_loading_times, "data_loading"))
        stats.update(calc_stats(self.forward_pass_times, "forward_pass"))
        stats.update(calc_stats(self.backward_pass_times, "backward_pass"))
        stats.update(calc_stats(self.total_batch_times, "total_batch"))

        # Overall statistics
        stats["total_batches"] = self.batch_count
        stats["total_samples_processed"] = self.total_samples_processed

        if self.total_batch_times:
            total_time = sum(self.total_batch_times)
            stats["throughput_samples_per_sec"] = self.total_samples_processed / total_time if total_time > 0 else 0
            stats["throughput_batches_per_sec"] = self.batch_count / total_time if total_time > 0 else 0

        # Efficiency metrics
        if self.data_loading_times and self.total_batch_times:
            data_load_total = sum(self.data_loading_times)
            total_time = sum(self.total_batch_times)
            stats["data_loading_efficiency_pct"] = (data_load_total / total_time) * 100 if total_time > 0 else 0

        if self.interbatch_times and self.total_batch_times:
            interbatch_total = sum(self.interbatch_times)
            total_time = sum(self.total_batch_times)
            stats["interbatch_overhead_pct"] = (interbatch_total / total_time) * 100 if total_time > 0 else 0

        return stats

    def print_report(self):
        """Print a comprehensive profiling report"""
        stats = self.get_statistics()

        print("\n" + "="*70)
        print("INTERBATCH PROFILING REPORT")
        print("="*70)

        print(f"\nOverall Statistics:")
        print(f"  Total Batches: {stats.get('total_batches', 0)}")
        print(f"  Total Samples: {stats.get('total_samples_processed', 0)}")
        print(f"  Throughput: {stats.get('throughput_samples_per_sec', 0):.2f} samples/sec")
        print(f"  Batch Rate: {stats.get('throughput_batches_per_sec', 0):.2f} batches/sec")

        print(f"\nTiming Breakdown (ms):")
        phases = [
            ("Interbatch Time", "interbatch"),
            ("Data Loading", "data_loading"),
            ("Forward Pass", "forward_pass"),
            ("Backward Pass", "backward_pass"),
            ("Total Batch Time", "total_batch")
        ]

        print(f"{'Phase':<20} {'Mean':<8} {'Median':<8} {'Std':<8} {'Min':<8} {'Max':<8}")
        print("-" * 70)

        for phase_name, key in phases:
            mean = stats.get(f"{key}_mean_ms", 0)
            median = stats.get(f"{key}_median_ms", 0)
            std = stats.get(f"{key}_std_ms", 0)
            min_val = stats.get(f"{key}_min_ms", 0)
            max_val = stats.get(f"{key}_max_ms", 0)
            count = stats.get(f"{key}_count", 0)

            if count > 0:
                print(f"{phase_name:<20} {mean:>7.1f} {median:>7.1f} {std:>7.1f} {min_val:>7.1f} {max_val:>7.1f}")

        print(f"\nEfficiency Metrics:")
        data_efficiency = stats.get("data_loading_efficiency_pct", 0)
        interbatch_overhead = stats.get("interbatch_overhead_pct", 0)

        print(f"  Data Loading Time: {data_efficiency:.1f}% of total batch time")
        print(f"  Interbatch Overhead: {interbatch_overhead:.1f}% of total time")

        print(f"\nRecommendations:")
        recommendations = []

        # Data loading recommendations
        if data_efficiency > 20:
            recommendations.append("• Data loading is taking >20% of batch time - consider increasing num_workers")
            recommendations.append("• Enable pin_memory=True if using GPU")
            recommendations.append("• Consider using prefetch_factor > 2")

        # Interbatch recommendations
        if interbatch_overhead > 10:
            recommendations.append("• High interbatch overhead detected - check for synchronization issues")
            recommendations.append("• Consider using non_blocking=True for tensor transfers")

        # Forward/backward pass recommendations
        forward_mean = stats.get("forward_pass_mean_ms", 0)
        backward_mean = stats.get("backward_pass_mean_ms", 0)

        if forward_mean > 0 and backward_mean > 0:
            if backward_mean > forward_mean * 1.5:
                recommendations.append("• Backward pass is significantly slower than forward - check gradient computation")
            elif forward_mean > backward_mean * 2:
                recommendations.append("• Forward pass is much slower than backward - check model efficiency")

        # Throughput recommendations
        throughput = stats.get("throughput_samples_per_sec", 0)
        if throughput < 10:  # Assuming this is low for the model
            recommendations.append("• Low throughput detected - consider optimizing batch size or model architecture")

        if not recommendations:
            recommendations.append("• Profiling results look good - no immediate optimizations needed")

        for rec in recommendations:
            print(rec)

        print("="*70)

