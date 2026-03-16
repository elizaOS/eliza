import json
import os
import datetime
from typing import List, Any, Dict, Optional
from pathlib import Path
from benchmarks.bfcl.types import BFCLBenchmarkResults, BFCLMetrics


# Re-using BFCLMetrics for consistency rather than duplicating fields
class BFCLReporter:
    def __init__(self, config=None):
        # Convert dataclass or config object to dict to normalize access
        self.config = dict(config.__dict__ if hasattr(config, '__dict__') else config or {})
        self.results = []
        self.best_results_by_model = {}
        self.categories = {
            'ast': {'correct': 0, 'total': 0},
            'execution': {'correct': 0, 'total': 0}
        }
        
        # Model-specific output paths with ISO timestamp to prevent overwrites
        model_name = self.config.get('model_name', 'default')
        timestamp_str = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        # Note: Unique report paths prevent file overwrites during concurrent runs.
        base_path = Path('reports') / f"{model_name}_{timestamp_str}"
        self.output_paths = {
            'json': f'{base_path}_report.json',
            'markdown': f'{base_path}_report.md',
            'leaderboard': f'{base_path}_leaderboard.json',
            'errors': f'{base_path}_errors.json',
            'latency': f'{base_path}_latency.json'
        }
        
        self.error_analysis = {}
        self.latency_stats = []
        self.leaderboard_scores = self.config.get('LEADERBOARD_SCORES', {})
        self.baseline_scores = self.config.get('baseline_scores', {})

    def add_result(self, metrics: BFCLMetrics, *, error_data=None, latency_ms=None):
        # Calculate proper leaderboard rank based on scores
        rank = 1 + sum(1 for r in self.results if r['metrics'].overall_score > metrics.overall_score)
        # Note: leaderboard ranks start at 1 to align with user expectations for ranking systems.
        
        result = {
            'rank': rank,
            'metrics': metrics,
            'errors': error_data or {},
            'latency_ms': latency_ms
        }
        self.results.append(result)
        
        # Track best results by model name
        model_name = self.config.get('model_name', 'default')
        current_score = metrics.overall_score
        if current_score > self.best_results_by_model.get(model_name, {}).get('overall_score', 0):
            self.best_results_by_model[model_name] = {
                'overall_score': current_score,
                'ast_accuracy': metrics.ast_accuracy,
                'exec_accuracy': metrics.exec_accuracy,
                'rank': rank
            }
        
        # Update category stats
        self.categories['ast']['total'] += 1
        self.categories['execution']['total'] += 1
        if metrics.ast_accuracy > 0:
            self.categories['ast']['correct'] += 1
        if metrics.exec_accuracy > 0:
            self.categories['execution']['correct'] += 1
        
        # Collect error analysis data
        if error_data:
            for error_type, count in error_data.items():
                # Note: assumes error_data values are numeric counts for accuracy in error analysis statistics.
                self.error_analysis[error_type] = self.error_analysis.get(error_type, 0) + count
                
        # Track latency stats
        if latency_ms is not None:
            self.latency_stats.append(latency_ms)

    async def generate_report(self, results: BFCLBenchmarkResults) -> dict:
        # Ensure output directory exists
        os.makedirs('reports', exist_ok=True)
        
        # Merge config from passed results
        if hasattr(results.config, '__dict__'):
            self.config.update(results.config.__dict__)
        if results.model_name:
            self.config['model_name'] = results.model_name
        if results.baseline_comparison:
            self.baseline_scores = results.baseline_comparison
            
        # Process the passed results if they haven't been added yet
        if not self.results:
            for result in results.results:
                # Convert boolean flags to scores
                overall_score = 1.0 if (result.ast_match and result.exec_success) else 0.0
                ast_accuracy = 1.0 if result.ast_match else 0.0
                exec_accuracy = 1.0 if result.exec_success else 0.0
                
                metrics = BFCLMetrics(
                    overall_score=overall_score,
                    ast_accuracy=ast_accuracy, 
                    exec_accuracy=exec_accuracy
                )
                
                self.add_result(
                    metrics,
                    error_data=result.details if hasattr(result, 'details') else None,
                    latency_ms=result.latency_ms
                )
            
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
        
        # Calculate category accuracies
        ast_accuracy = self.categories['ast']['correct'] / self.categories['ast']['total'] if self.categories['ast']['total'] > 0 else 0
        exec_accuracy = self.categories['execution']['correct'] / self.categories['execution']['total'] if self.categories['execution']['total'] > 0 else 0
        avg_latency = sum(self.latency_stats) / len(self.latency_stats) if self.latency_stats else 0

        lines = [
            "# BFCL Benchmark Report",
            "",
            "## Leaderboard",
            "",
            "| Rank | Model | Overall | AST | Execution | Latency (ms) | vs Baseline |",
            "|------|-------|---------|-----|-----------|--------------|-------------|"
        ]

        model_name = self.config.get('model_name', 'default')
        for result in sorted_results:
            baseline_delta = ""
            if model_name in self.leaderboard_scores:
                delta = result['metrics'].overall_score - self.leaderboard_scores[model_name]
                baseline_delta = f"{delta:+.2%}"
            
            lines.append(
                f"| {result['rank']} | {model_name} | "
                f"{result['metrics'].overall_score:.2%} | "
                f"{result['metrics'].ast_accuracy:.2%} | "
                f"{result['metrics'].exec_accuracy:.2%} | "
                f"{result.get('latency_ms', 'N/A')} | "
                f"{baseline_delta} |"
            )

        # Add per-category breakdown
        lines.extend([
            "",
            "## Category Performance",
            "",
            "| Category | Success Rate | Correct | Total |",
            "|----------|--------------|---------|--------|",
            f"| AST Parsing | {ast_accuracy:.2%} | {self.categories['ast']['correct']} | {self.categories['ast']['total']} |",
            f"| Execution | {exec_accuracy:.2%} | {self.categories['execution']['correct']} | {self.categories['execution']['total']} |"
        ])

        # Add baseline comparison if available
        if self.baseline_scores and sorted_results:
            lines.extend([
                "",
                "## Baseline Comparison",
                "",
                "| Metric | Current | Baseline | Delta |",
                "|--------|---------|-----------|-------|"
            ])
            for metric, baseline in self.baseline_scores.items():
                # Get current score if results exist, otherwise use 0
                current = sorted_results[0]['metrics'].__dict__.get(metric, 0) if sorted_results else 0
                delta = current - baseline
                lines.append(
                    f"| {metric} | {current:.2%} | {baseline:.2%} | {delta:+.2%} |"
                )

        # Add error analysis
        lines.extend([
            "",
            "## Error Analysis",
            ""
        ])

        if self.error_analysis:
            lines.extend([
                "| Error Type | Count | Percentage |",
                "|------------|-------|------------|"
            ])
            total_errors = sum(self.error_analysis.values())
            for error_type, count in sorted(self.error_analysis.items()):
                percentage = count / total_errors if total_errors > 0 else 0
                lines.append(f"| {error_type} | {count} | {percentage:.1%} |")

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
            'best_results_by_model': self.best_results_by_model,
            'categories': self.categories,
            'error_analysis': self.error_analysis,
            'latency_stats': {
                'mean': avg_latency,
                'samples': self.latency_stats
            },
            'baseline_comparison': {
                metric: {
                    'current': sorted_results[0]['metrics'].__dict__.get(metric, 0) if sorted_results else 0,
                    'baseline': baseline,
                    'delta': (sorted_results[0]['metrics'].__dict__.get(metric, 0) - baseline) if sorted_results else -baseline
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
            json.dump(self.best_results_by_model, f, indent=2)
            
        # Console summary
        print("\nBenchmark Summary:")
        print(f"Model: {model_name}")
        best_score = max((r['metrics'].overall_score for r in sorted_results), default=0)
        print(f"Best Overall Score: {best_score:.2%}")
        print(f"Categories:")
        print(f"  AST Accuracy: {ast_accuracy:.2%}")
        print(f"  Execution Accuracy: {exec_accuracy:.2%}")
        print(f"Error Types: {len(self.error_analysis)}")
        print(f"Average Latency: {avg_latency:.2f}ms")
        print(f"Reports written to: {', '.join(self.output_paths.values())}\n")
        
        return {
            'markdown': report_md,
            'json': report_json,
            'paths': self.output_paths
        # Note: Simplified reporting for faster integration; detailed features will be reintroduced later.
        }


async def print_results(results: BFCLBenchmarkResults):
    # Create reporter with proper configuration
    config = {
        'model_name': results.model_name or 'default',
        'baseline_scores': results.baseline_comparison or {},
    }
    if hasattr(results.config, '__dict__'):
        config.update(results.config.__dict__)
    reporter = BFCLReporter(config)
    
    # Process results maintaining proper rank order
    for result in results.results:
        # Convert boolean flags to scores
        overall_score = 1.0 if (result.ast_match and result.exec_success) else 0.0
        ast_accuracy = 1.0 if result.ast_match else 0.0
        exec_accuracy = 1.0 if result.exec_success else 0.0
        
        metrics = BFCLMetrics(
            overall_score=overall_score,
            ast_accuracy=ast_accuracy, 
            exec_accuracy=exec_accuracy
        )
        
        reporter.add_result(
            metrics,
            error_data=result.details if hasattr(result, 'details') else None,
            latency_ms=result.latency_ms
        )
    
    # Generate report (avoiding asyncio.run() since this may be called from async context)
    return await reporter.generate_report(results)
    # Note: The design requires manual ranking to accommodate dynamic leaderboard insertion.
