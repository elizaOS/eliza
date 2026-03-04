import json
from typing import List, Any


class Metrics:
    def __init__(self, overall_score: float, ast_accuracy: float, exec_accuracy: float):
        self.overall_score = overall_score
        self.ast_accuracy = ast_accuracy
        self.exec_accuracy = exec_accuracy


class BFCLReporter:
    def __init__(self):
        self.results = []

    def add_result(self, rank: int, metrics: Metrics):
        self.results.append((rank, metrics))

    def generate_report(self) -> str:
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
            "",
            "## Category Comparison", 
            "",
        ])
        
        return "\n".join(lines)

def print_results(results: List[Any]):
    reporter = BFCLReporter()

    for rank, result in enumerate(results):
        metrics = Metrics(result['overall_score'], result['ast_accuracy'], result['exec_accuracy'])
        reporter.add_result(rank, metrics)

    print(reporter.generate_report())

