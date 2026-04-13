"""Position Analyzer for Context Benchmark.

Analyzes retrieval performance by needle position to detect
"lost in the middle" effects and other position-based patterns.
"""

from collections import defaultdict

from elizaos_context_bench.types import (
    ContextBenchResult,
    LengthAccuracy,
    NeedlePosition,
    PositionAccuracy,
)


class PositionAnalyzer:
    """Analyze retrieval performance by position."""

    def __init__(self, results: list[ContextBenchResult] | None = None):
        """Initialize the position analyzer.

        Args:
            results: Optional list of results to analyze.

        """
        self.results = results or []

    def add_results(self, results: list[ContextBenchResult]) -> None:
        """Add results to the analyzer."""
        self.results.extend(results)

    def calculate_position_accuracy(self) -> dict[NeedlePosition, PositionAccuracy]:
        """Calculate accuracy metrics by needle position.

        Returns:
            Dictionary mapping positions to accuracy metrics.

        """
        position_results: dict[NeedlePosition, list[ContextBenchResult]] = defaultdict(
            list
        )

        for result in self.results:
            position_results[result.needle_position].append(result)

        accuracies: dict[NeedlePosition, PositionAccuracy] = {}

        for position, results in position_results.items():
            total = len(results)
            if total == 0:
                continue

            correct = sum(1 for r in results if r.retrieval_success)
            accuracy = correct / total

            avg_similarity = sum(r.semantic_similarity for r in results) / total
            avg_latency = sum(r.latency_ms for r in results) / total

            accuracies[position] = PositionAccuracy(
                position=position,
                total_tasks=total,
                correct_tasks=correct,
                accuracy=accuracy,
                avg_semantic_similarity=avg_similarity,
                avg_latency_ms=avg_latency,
            )

        return accuracies

    def calculate_length_accuracy(self) -> dict[int, LengthAccuracy]:
        """Calculate accuracy metrics by context length.

        Returns:
            Dictionary mapping context lengths to accuracy metrics.

        """
        length_results: dict[int, list[ContextBenchResult]] = defaultdict(list)

        for result in self.results:
            # Bucket by approximate length (round to nearest power of 2)
            bucket = self._get_length_bucket(result.context_length)
            length_results[bucket].append(result)

        accuracies: dict[int, LengthAccuracy] = {}

        for length, results in length_results.items():
            total = len(results)
            if total == 0:
                continue

            correct = sum(1 for r in results if r.retrieval_success)
            accuracy = correct / total

            avg_similarity = sum(r.semantic_similarity for r in results) / total
            avg_latency = sum(r.latency_ms for r in results) / total

            accuracies[length] = LengthAccuracy(
                context_length=length,
                total_tasks=total,
                correct_tasks=correct,
                accuracy=accuracy,
                avg_semantic_similarity=avg_similarity,
                avg_latency_ms=avg_latency,
            )

        return accuracies

    @staticmethod
    def _get_length_bucket(length: int) -> int:
        """Get the bucket for a context length (nearest power of 2 or common size)."""
        buckets = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]
        for bucket in buckets:
            if length <= bucket * 1.5:
                return bucket
        return buckets[-1]

    def detect_lost_in_middle(self) -> tuple[bool, float]:
        """Detect if model exhibits 'lost in the middle' behavior.

        This is indicated by lower accuracy for middle positions compared
        to start and end positions.

        Returns:
            Tuple of (has_lost_in_middle_effect, severity_score).
            Severity is the relative accuracy drop for middle vs edges.

        """
        position_accuracies = self.calculate_position_accuracy()

        # Get edge and middle accuracies
        edge_positions = [NeedlePosition.START, NeedlePosition.END]
        middle_positions = [NeedlePosition.MIDDLE]

        edge_acc_values: list[float] = []
        for pos in edge_positions:
            if pos in position_accuracies:
                edge_acc_values.append(position_accuracies[pos].accuracy)

        middle_acc_values: list[float] = []
        for pos in middle_positions:
            if pos in position_accuracies:
                middle_acc_values.append(position_accuracies[pos].accuracy)

        if not edge_acc_values or not middle_acc_values:
            return False, 0.0

        avg_edge_acc = sum(edge_acc_values) / len(edge_acc_values)
        avg_middle_acc = sum(middle_acc_values) / len(middle_acc_values)

        # Calculate severity as relative drop
        severity = (
            (avg_edge_acc - avg_middle_acc) / avg_edge_acc if avg_edge_acc > 0 else 0.0
        )

        # Lost in middle if middle accuracy is significantly lower
        has_effect = severity > 0.1  # More than 10% drop

        return has_effect, max(0.0, severity)

    def calculate_context_degradation(self) -> float:
        """Calculate how much accuracy degrades as context length increases.

        Returns:
            Degradation rate (accuracy drop per doubling of context length).

        """
        length_accuracies = self.calculate_length_accuracy()

        if len(length_accuracies) < 2:
            return 0.0

        # Sort by length
        sorted_lengths = sorted(length_accuracies.keys())

        # Calculate degradation between consecutive buckets
        degradations: list[float] = []
        for i in range(1, len(sorted_lengths)):
            prev_length = sorted_lengths[i - 1]
            curr_length = sorted_lengths[i]

            prev_acc = length_accuracies[prev_length].accuracy
            curr_acc = length_accuracies[curr_length].accuracy

            # Calculate how many doublings between these lengths
            ratio = curr_length / prev_length
            if ratio > 1:
                import math
                doublings = math.log2(ratio)
                if doublings > 0:
                    degradation_per_doubling = (prev_acc - curr_acc) / doublings
                    degradations.append(degradation_per_doubling)

        return sum(degradations) / len(degradations) if degradations else 0.0

    def generate_position_heatmap(
        self,
    ) -> tuple[list[list[float]], list[int], list[NeedlePosition]]:
        """Generate 2D data for heatmap visualization.

        Returns:
            Tuple of (heatmap_data, length_labels, position_labels).
            heatmap_data[i][j] is accuracy for position i at length j.

        """
        # Group results by position and length
        grouped: dict[
            tuple[NeedlePosition, int], list[ContextBenchResult]
        ] = defaultdict(list)

        for result in self.results:
            bucket = self._get_length_bucket(result.context_length)
            key = (result.needle_position, bucket)
            grouped[key].append(result)

        # Get unique positions and lengths
        positions = sorted(
            {r.needle_position for r in self.results},
            key=lambda p: list(NeedlePosition).index(p),
        )
        lengths = sorted({self._get_length_bucket(r.context_length) for r in self.results})

        # Build heatmap
        heatmap: list[list[float]] = []
        for position in positions:
            row: list[float] = []
            for length in lengths:
                key = (position, length)
                if key in grouped:
                    results = grouped[key]
                    accuracy = (
                        sum(1 for r in results if r.retrieval_success) / len(results)
                    )
                else:
                    accuracy = 0.0
                row.append(accuracy)
            heatmap.append(row)

        return heatmap, lengths, positions

    def get_summary_stats(self) -> dict[str, float | int | bool]:
        """Get summary statistics for the analysis.

        Returns:
            Dictionary of summary statistics.

        """
        if not self.results:
            return {}

        total = len(self.results)
        correct = sum(1 for r in self.results if r.retrieval_success)
        overall_accuracy = correct / total

        has_lost_in_middle, lost_in_middle_severity = self.detect_lost_in_middle()
        degradation_rate = self.calculate_context_degradation()

        avg_latency = sum(r.latency_ms for r in self.results) / total
        avg_similarity = sum(r.semantic_similarity for r in self.results) / total

        return {
            "total_tasks": total,
            "correct_tasks": correct,
            "overall_accuracy": overall_accuracy,
            "has_lost_in_middle_effect": has_lost_in_middle,
            "lost_in_middle_severity": lost_in_middle_severity,
            "context_degradation_rate": degradation_rate,
            "avg_latency_ms": avg_latency,
            "avg_semantic_similarity": avg_similarity,
        }
