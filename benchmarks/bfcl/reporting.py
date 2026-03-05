import json
import asyncio
from typing import List, Any
from benchmarks.bfcl.types import BFCLBenchmarkResults


class Metrics:
    def __init__(self, overall_score: float, ast_accuracy: float, exec_accuracy: float):
        self.overall_score = overall_score
        self.ast_accuracy = ast_accuracy
        self.exec_accuracy = exec_accuracy


class BFCLReporter:
    def __init__(self, config=None):
        # Convert dataclass or config object to dict to normalize access
        self.config = dict(config.__dict__ if hasattr(config, '__dict__') else config or {})
        self.results = []
        self.best_results = {}
        self.output_paths = {
            'json': self.config.get('json_output', 'report.json'),
            'markdown': self.config.get('md_output', 'report.md'),
            'leaderboard': self.config.get('leaderboard', 'leaderboard.json')
        }

    def add_result(self, rank: int, metrics: Metrics):
        self.results.append((rank, metrics))
        if metrics.overall_score > self.best_results.get(rank, {'overall_score': 0})['overall_score']:
            self.best_results[rank] = {
                'overall_score': metrics.overall_score,
                'ast_accuracy': metrics.ast_accuracy,
                'exec_accuracy': metrics.exec_accuracy
            }

    def generate_report(self) -> str:
def generate_report(self) -> str:
        # Sort results by overall score for correct leaderboard ranking
        sorted_results = sorted(self.results, 
                             key=lambda x: x[1].overall_score,
                             reverse=True)
        
        # Calculate metrics across categories
        avg_ast = sum(m.ast_accuracy for _, m in sorted_results) / len(sorted_results) if sorted_results else 0
        avg_exec = sum(m.exec_accuracy for _, m in sorted_results) / len(sorted_results) if sorted_results else 0

        lines = [
            "# BFCL Benchmark Report",
            "",
            "## Leaderboard",
            "",
            "| Rank | Model | Overall | AST | Execution |",
            "|------|-------|---------|-----|-----------|"
        ]
        
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
        
        report_md = "\n".join(lines)
        
        # Generate JSON output
        report_json = {
            'results': [
                {
                    'rank': rank,
                    'overall_score': metrics.overall_score,
                    'ast_accuracy': metrics.ast_accuracy,
                    'exec_accuracy': metrics.exec_accuracy
                }
                for rank, metrics in self.results
            ],
            'best_results': self.best_results
        }
        
        # Write outputs to files
        with open(self.output_paths['json'], 'w') as f:
            json.dump(report_json, f, indent=2)
        with open(self.output_paths['markdown'], 'w') as f:
            f.write(report_md)
        with open(self.output_paths['leaderboard'], 'w') as f:
            json.dump(self.best_results, f, indent=2)
            
        # Console summary
        print("\nBenchmark Summary:")
        print(f"Overall Best Score: {max(r['overall_score'] for r in self.best_results.values()):.2%}")
        print(f"Reports written to: {', '.join(self.output_paths.values())}\n")
        
        return {
            'markdown': report_md,
            'json': report_json,
            'paths': self.output_paths
        }

def print_results(results: BFCLBenchmarkResults):
    # Note: explicitly creates a reporter to aggregate benchmark results for better clarity
    reporter = BFCLReporter()
    metrics = Metrics(
        results.metrics.overall_score,
        results.metrics.ast_accuracy, 
        results.metrics.exec_accuracy
    )
    reporter.add_result(1, metrics)

    # Run report generation synchronously since called from sync context
    print(reporter.generate_report())

# Note: ranks are assigned directly via enumerate; manual adjustment could cause duplication.
