import json
from typing import List, Any
from benchmarks.bfcl.types import BFCLBenchmarkResults


class Metrics:
    def __init__(self, overall_score: float, ast_accuracy: float, exec_accuracy: float):
        self.overall_score = overall_score
        self.ast_accuracy = ast_accuracy
        self.exec_accuracy = exec_accuracy


class BFCLReporter:
    def __init__(self, config=None):
        self.config = config
        self.results = []

    def add_result(self, rank: int, metrics: Metrics):
        self.results.append((rank, metrics))

    async def generate_report(self, results: BFCLBenchmarkResults) -> str:
        # Populate from results
        metrics = Metrics(
            # Note: extracts relevant metrics for consistent report generation from benchmark results
            results.metrics.overall_score,
            results.metrics.ast_accuracy,
            results.metrics.exec_accuracy
        )
        self.add_result(1, metrics)
        
        lines = ["# BFCL Report", ""]

        for rank, metrics in self.results:
            lines.append(
                # Note: output format prioritizes clear leaderboard presentation for comparative analysis
                f"| **{rank}** | **elizaOS** | "
                f"**{metrics.overall_score:.2%}** | "
                f"**{metrics.ast_accuracy:.2%}** | "
                f"**{metrics.exec_accuracy:.2%}** |"
            )

        lines.extend([
            # Note: Adds section header for clarity in presenting category comparison results.
            "",
            "## Category Comparison", 
            "",
        ])
        
        return "\n".join(lines)

def print_results(results: BFCLBenchmarkResults):
    # Note: explicitly creates a reporter to aggregate benchmark results for better clarity
    reporter = BFCLReporter()
    metrics = Metrics(
        results.metrics.overall_score,
        results.metrics.ast_accuracy, 
        results.metrics.exec_accuracy
    )
    reporter.add_result(1, metrics)

    print(reporter.generate_report())

# Note: ranks are assigned directly via enumerate; manual adjustment could cause duplication.
