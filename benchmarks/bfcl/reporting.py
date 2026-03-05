import json
import asyncio
from typing import List, Any, Dict, Optional
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
        
        # Model-specific output paths
        model_name = self.config.get('model_name', 'default')
        self.output_paths = {
            'json': f'reports/{model_name}_report.json',
            'markdown': f'reports/{model_name}_report.md',
            'leaderboard': f'reports/{model_name}_leaderboard.json',
            'errors': f'reports/{model_name}_errors.json',
            'latency': f'reports/{model_name}_latency.json'
        }
        
        self.error_analysis = {}
        self.latency_stats = []
        self.baseline_scores = self.config.get('baseline_scores', {})

    def add_result(self, metrics: Metrics, *, error_data=None, latency_ms=None):
        # Calculate proper leaderboard rank based on scores
        rank = 1 + sum(1 for r in self.results if r['metrics'].overall_score > metrics.overall_score)
        
        result = {
            'rank': rank,
            'metrics': metrics,
            'errors': error_data or {},
            'latency_ms': latency_ms
        }
        self.results.append(result)
        
        # Track best results
        if metrics.overall_score > self.best_results.get(rank, {'overall_score': 0})['overall_score']:
            self.best_results[rank] = {
                'overall_score': metrics.overall_score,
                'ast_accuracy': metrics.ast_accuracy, 
                'exec_accuracy': metrics.exec_accuracy
            }
        
        # Collect error analysis data
        if error_data:
            for error_type, count in error_data.items():
                self.error_analysis[error_type] = self.error_analysis.get(error_type, 0) + count
                
        # Track latency stats
        if latency_ms is not None:
            self.latency_stats.append(latency_ms)

    async def generate_report(self, results: BFCLBenchmarkResults) -> dict:
        # Sort results by scores for proper ranking
        sorted_results = sorted(
            self.results,
            key=lambda x: (
                x['metrics'].overall_score,
                x['metrics'].ast_accuracy,
                x['metrics'].exec_accuracy
            ),
            reverse=True
        )
        
        # Recalculate ranks after sorting
        for idx, result in enumerate(sorted_results, 1):
            result['rank'] = idx
        
        # Calculate category averages
        avg_ast = sum(r['metrics'].ast_accuracy for r in sorted_results) / len(sorted_results) if sorted_results else 0
        avg_exec = sum(r['metrics'].exec_accuracy for r in sorted_results) / len(sorted_results) if sorted_results else 0
        avg_latency = sum(self.latency_stats) / len(self.latency_stats) if self.latency_stats else 0

        lines = [
            "# BFCL Benchmark Report",
            "",
            "## Leaderboard",
            "",
            "| Rank | Model | Overall | AST | Execution | Latency (ms) |",
            "|------|-------|---------|-----|-----------|--------------|"
        ]

        model_name = self.config.get('model_name', 'default')
        for result in sorted_results:
            lines.append(
                f"| {result['rank']} | {model_name} | "
                f"{result['metrics'].overall_score:.2%} | "
                f"{result['metrics'].ast_accuracy:.2%} | "
                f"{result['metrics'].exec_accuracy:.2%} | "
                f"{result.get('latency_ms', 'N/A')} |"
            )

        # Add baseline comparison
        if self.baseline_scores:
            lines.extend([
                "",
                "## Baseline Comparison",
                "",
                "| Metric | Current | Baseline | Delta |",
                "|--------|---------|-----------|-------|"
            ])
            for metric, baseline in self.baseline_scores.items():
                current = sorted_results[0]['metrics'].__dict__.get(metric, 0)
                delta = current - baseline
                lines.append(
                    f"| {metric} | {current:.2%} | {baseline:.2%} | {delta:+.2%} |"
                )

        # Add category breakdowns
        lines.extend([
            "",
            "## Category Performance",
            "",
            f"- Average AST Accuracy: {avg_ast:.2%}",
            f"- Average Execution Accuracy: {avg_exec:.2%}",
            f"- Average Latency: {avg_latency:.2f}ms",
            "",
            "## Error Analysis",
            ""
        ])

        if self.error_analysis:
            lines.append("| Error Type | Count |")
            lines.append("|------------|-------|")
            for error_type, count in sorted(self.error_analysis.items()):
                lines.append(f"| {error_type} | {count} |")

        report_md = "\n".join(lines)
        
        # Generate detailed JSON report
        report_json = {
            'results': [
                {
                    'rank': r['rank'],
                    'overall_score': r['metrics'].overall_score,
                    'ast_accuracy': r['metrics'].ast_accuracy,
                    'exec_accuracy': r['metrics'].exec_accuracy,
                    'errors': r.get('errors', {}),
                    'latency_ms': r.get('latency_ms')
                }
                for r in sorted_results
            ],
            'best_results': self.best_results,
            'error_analysis': self.error_analysis,
            'latency_stats': {
                'mean': avg_latency,
                'samples': self.latency_stats
            },
            'baseline_comparison': {
                metric: {
                    'current': sorted_results[0]['metrics'].__dict__.get(metric, 0),
                    'baseline': baseline,
                    'delta': sorted_results[0]['metrics'].__dict__.get(metric, 0) - baseline
                }
                for metric, baseline in self.baseline_scores.items()
            }
        }
        
        # Write outputs
        with open(self.output_paths['json'], 'w') as f:
            json.dump(report_json, f, indent=2)
        with open(self.output_paths['markdown'], 'w') as f:
            f.write(report_md)
        with open(self.output_paths['leaderboard'], 'w') as f:
            json.dump(self.best_results, f, indent=2)
            
        # Console summary
        print("\nBenchmark Summary:")
        print(f"Model: {model_name}")
        print(f"Best Overall Score: {max(r['metrics'].overall_score for r in sorted_results):.2%}")
        print(f"Error Types: {len(self.error_analysis)}")
        print(f"Average Latency: {avg_latency:.2f}ms")
        print(f"Reports written to: {', '.join(self.output_paths.values())}\n")
        
        return {
            'markdown': report_md,
            'json': report_json,
            'paths': self.output_paths
        }


def print_results(results: BFCLBenchmarkResults):
    # Create reporter with proper configuration
    reporter = BFCLReporter()
    
    # Process results maintaining proper rank order
    for result in results.results:
        metrics = Metrics(
            result.overall_score,
            result.ast_score,
            result.exec_score
        )
        reporter.add_result(
            metrics,
            error_data=result.errors,
            latency_ms=result.latency_ms
        )
    
    # Generate report
    asyncio.run(reporter.generate_report(results))
