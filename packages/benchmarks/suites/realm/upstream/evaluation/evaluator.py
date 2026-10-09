"""
Task Evaluator for REALM-Bench

This module provides the main evaluation framework for assessing multi-agent planning
performance across different frameworks and tasks.
"""

import time
import json
import os
from typing import Dict, List, Any, Optional, Callable
from dataclasses import dataclass, field
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

from .metrics import (
    PlanningQualityMetrics,
    PlanningOptimalityMetrics,
    CoordinationEffectivenessMetrics,
    ConstraintSatisfactionMetrics,
    ResourceUsageMetrics,
    AdaptationMetrics
)
from .task_definitions import TaskDefinition, TaskResult, TASK_DEFINITIONS


@dataclass
class EvaluationConfig:
    """Configuration for evaluation runs"""
    frameworks: List[str] = field(default_factory=lambda: ["langgraph", "autogen", "crewai", "swarm"])
    tasks: List[str] = field(default_factory=lambda: list(TASK_DEFINITIONS.keys()))
    num_runs: int = 3
    timeout_seconds: int = 300
    output_dir: str = "evaluation_results"
    enable_visualization: bool = True
    save_detailed_results: bool = True


class TaskEvaluator:
    """Evaluates a single task across different frameworks"""
    
    def __init__(self, task_id: str, config: EvaluationConfig):
        self.task_id = task_id
        self.config = config
        self.task_definition = TASK_DEFINITIONS[task_id]
        
        # Initialize metric evaluators
        self.planning_quality = PlanningQualityMetrics()
        self.planning_optimality = PlanningOptimalityMetrics()
        self.coordination_effectiveness = CoordinationEffectivenessMetrics()
        self.constraint_satisfaction = ConstraintSatisfactionMetrics()
        self.resource_usage = ResourceUsageMetrics()
        self.adaptation = AdaptationMetrics()
    
    def evaluate_framework(self, framework: str, framework_runner: Callable) -> TaskResult:
        """Evaluate a single framework on this task"""
        start_time = time.time()
        
        try:
            # Run the framework
            execution_result = framework_runner(self.task_definition)
            
            # Calculate metrics
            metrics = self._calculate_metrics(execution_result)
            
            execution_time = time.time() - start_time
            
            return TaskResult(
                task_id=self.task_id,
                framework=framework,
                execution_time=execution_time,
                achieved_goals=execution_result.get('achieved_goals', []),
                satisfied_constraints=execution_result.get('satisfied_constraints', []),
                resource_usage=execution_result.get('resource_usage', {}),
                schedule=execution_result.get('schedule', []),
                disruptions_handled=execution_result.get('disruptions_handled', []),
                replanning_attempts=execution_result.get('replanning_attempts', []),
                metrics=metrics
            )
            
        except Exception as e:
            print(f"Error evaluating {framework} on {self.task_id}: {str(e)}")
            return TaskResult(
                task_id=self.task_id,
                framework=framework,
                execution_time=time.time() - start_time,
                achieved_goals=[],
                satisfied_constraints=[],
                resource_usage={},
                schedule=[],
                disruptions_handled=[],
                replanning_attempts=[],
                metrics={}
            )
    
    def _calculate_metrics(self, execution_result: Dict[str, Any]) -> Dict[str, float]:
        """Calculate all metrics for the execution result"""
        metrics = {}
        
        # Planning Quality Metrics
        expected_goals = [goal.goal_id for goal in self.task_definition.goals]
        achieved_goals = execution_result.get('achieved_goals', [])
        
        goal_result = self.planning_quality.evaluate_goal_satisfaction(
            expected_goals, achieved_goals
        )
        metrics['goal_satisfaction_rate'] = goal_result.value
        
        # Planning Optimality Metrics
        schedule = execution_result.get('schedule', [])
        makespan_result = self.planning_optimality.evaluate_makespan(schedule)
        metrics['makespan'] = makespan_result.value
        
        # Constraint Satisfaction Metrics
        constraints = [
            {
                'id': c.constraint_id,
                'type': c.constraint_type,
                'parameters': c.parameters
            }
            for c in self.task_definition.constraints
        ]
        
        constraint_result = self.constraint_satisfaction.evaluate_constraint_satisfaction(
            constraints, execution_result
        )
        metrics['constraint_satisfaction_rate'] = constraint_result.value
        
        # Resource Usage Metrics
        resource_usage = execution_result.get('resource_usage', {})
        if 'memory_usage' in resource_usage:
            memory_result = self.resource_usage.evaluate_memory_usage(
                resource_usage['memory_usage']
            )
            metrics['memory_usage'] = memory_result.value
        
        if 'execution_times' in resource_usage:
            time_result = self.resource_usage.evaluate_time_usage(
                resource_usage['execution_times']
            )
            metrics['execution_time'] = time_result.value
        
        if 'token_usage' in resource_usage:
            token_result = self.resource_usage.evaluate_token_usage(
                resource_usage['token_usage']
            )
            metrics['token_usage'] = token_result.value
        
        # Adaptation Metrics (if disruptions present)
        disruptions = execution_result.get('disruptions_handled', [])
        replanning_attempts = execution_result.get('replanning_attempts', [])
        
        if disruptions:
            adaptation_result = self.adaptation.evaluate_replanning_success(
                disruptions, replanning_attempts
            )
            metrics['replanning_success_rate'] = adaptation_result.value
        
        return metrics


class FrameworkEvaluator:
    """Evaluates a single framework across all tasks"""
    
    def __init__(self, framework: str, config: EvaluationConfig):
        self.framework = framework
        self.config = config
        self.results: List[TaskResult] = []
    
    def evaluate_all_tasks(self, framework_runner: Callable) -> List[TaskResult]:
        """Evaluate all tasks for this framework"""
        results = []
        
        for task_id in self.config.tasks:
            print(f"Evaluating {self.framework} on task {task_id}")
            
            task_evaluator = TaskEvaluator(task_id, self.config)
            
            # Run multiple times for statistical significance
            task_results = []
            for run in range(self.config.num_runs):
                result = task_evaluator.evaluate_framework(self.framework, framework_runner)
                task_results.append(result)
            
            # Aggregate results
            aggregated_result = self._aggregate_results(task_results)
            results.append(aggregated_result)
        
        self.results = results
        return results
    
    def _aggregate_results(self, results: List[TaskResult]) -> TaskResult:
        """Aggregate multiple runs into a single result"""
        if not results:
            return results[0] if results else None
        
        # Average the metrics
        avg_metrics = {}
        for metric in results[0].metrics.keys():
            values = [r.metrics.get(metric, 0) for r in results]
            avg_metrics[metric] = sum(values) / len(values)
        
        # Use the first result as base and update metrics
        aggregated = results[0]
        aggregated.metrics = avg_metrics
        aggregated.execution_time = sum(r.execution_time for r in results) / len(results)
        
        return aggregated


class BenchmarkEvaluator:
    """Main benchmark evaluator that orchestrates all evaluations"""
    
    def __init__(self, config: EvaluationConfig):
        self.config = config
        self.results: Dict[str, List[TaskResult]] = {}
        
        # Create output directory
        os.makedirs(config.output_dir, exist_ok=True)
    
    def run_benchmark(self, framework_runners: Dict[str, Callable]) -> Dict[str, List[TaskResult]]:
        """Run the complete benchmark"""
        print("Starting REALM-Bench evaluation...")
        
        for framework in self.config.frameworks:
            if framework not in framework_runners:
                print(f"Warning: No runner provided for framework {framework}")
                continue
            
            print(f"\nEvaluating framework: {framework}")
            framework_evaluator = FrameworkEvaluator(framework, self.config)
            results = framework_evaluator.evaluate_all_tasks(framework_runners[framework])
            self.results[framework] = results
        
        # Save results
        self._save_results()
        
        # Generate visualizations
        if self.config.enable_visualization:
            self._generate_visualizations()
        
        return self.results
    
    def _save_results(self):
        """Save evaluation results to files"""
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        
        # Save detailed results
        if self.config.save_detailed_results:
            for framework, results in self.results.items():
                filename = f"{self.config.output_dir}/{framework}_results_{timestamp}.json"
                with open(filename, 'w') as f:
                    json.dump([self._result_to_dict(r) for r in results], f, indent=2)
        
        # Save summary results
        summary = self._generate_summary()
        summary_filename = f"{self.config.output_dir}/benchmark_summary_{timestamp}.json"
        with open(summary_filename, 'w') as f:
            json.dump(summary, f, indent=2)
        
        # Save CSV for analysis
        df = self._create_results_dataframe()
        csv_filename = f"{self.config.output_dir}/benchmark_results_{timestamp}.csv"
        df.to_csv(csv_filename, index=False)
        
        print(f"Results saved to {self.config.output_dir}")
    
    def _result_to_dict(self, result: TaskResult) -> Dict[str, Any]:
        """Convert TaskResult to dictionary for JSON serialization"""
        return {
            'task_id': result.task_id,
            'framework': result.framework,
            'execution_time': result.execution_time,
            'achieved_goals': result.achieved_goals,
            'satisfied_constraints': result.satisfied_constraints,
            'resource_usage': result.resource_usage,
            'metrics': result.metrics
        }
    
    def _generate_summary(self) -> Dict[str, Any]:
        """Generate summary statistics"""
        summary = {
            'timestamp': time.strftime("%Y-%m-%d %H:%M:%S"),
            'config': {
                'frameworks': self.config.frameworks,
                'tasks': self.config.tasks,
                'num_runs': self.config.num_runs
            },
            'results': {}
        }
        
        for framework, results in self.results.items():
            framework_summary = {
                'total_tasks': len(results),
                'average_execution_time': sum(r.execution_time for r in results) / len(results),
                'average_goal_satisfaction': sum(r.metrics.get('goal_satisfaction_rate', 0) for r in results) / len(results),
                'average_constraint_satisfaction': sum(r.metrics.get('constraint_satisfaction_rate', 0) for r in results) / len(results),
                'average_makespan': sum(r.metrics.get('makespan', 0) for r in results) / len(results)
            }
            summary['results'][framework] = framework_summary
        
        return summary
    
    def _create_results_dataframe(self) -> pd.DataFrame:
        """Create a pandas DataFrame from results for analysis"""
        rows = []
        
        for framework, results in self.results.items():
            for result in results:
                row = {
                    'framework': framework,
                    'task_id': result.task_id,
                    'execution_time': result.execution_time,
                    'goal_satisfaction_rate': result.metrics.get('goal_satisfaction_rate', 0),
                    'constraint_satisfaction_rate': result.metrics.get('constraint_satisfaction_rate', 0),
                    'makespan': result.metrics.get('makespan', 0),
                    'memory_usage': result.metrics.get('memory_usage', 0),
                    'token_usage': result.metrics.get('token_usage', 0),
                    'replanning_success_rate': result.metrics.get('replanning_success_rate', 0)
                }
                rows.append(row)
        
        return pd.DataFrame(rows)
    
    def _generate_visualizations(self):
        """Generate visualization plots"""
        df = self._create_results_dataframe()
        
        # Set up the plotting style
        plt.style.use('seaborn-v0_8')
        fig, axes = plt.subplots(2, 3, figsize=(18, 12))
        fig.suptitle('REALM-Bench Evaluation Results', fontsize=16)
        
        # 1. Goal Satisfaction Rate by Framework
        sns.boxplot(data=df, x='framework', y='goal_satisfaction_rate', ax=axes[0, 0])
        axes[0, 0].set_title('Goal Satisfaction Rate by Framework')
        axes[0, 0].set_ylabel('Goal Satisfaction Rate (%)')
        
        # 2. Constraint Satisfaction Rate by Framework
        sns.boxplot(data=df, x='framework', y='constraint_satisfaction_rate', ax=axes[0, 1])
        axes[0, 1].set_title('Constraint Satisfaction Rate by Framework')
        axes[0, 1].set_ylabel('Constraint Satisfaction Rate (%)')
        
        # 3. Execution Time by Framework
        sns.boxplot(data=df, x='framework', y='execution_time', ax=axes[0, 2])
        axes[0, 2].set_title('Execution Time by Framework')
        axes[0, 2].set_ylabel('Execution Time (seconds)')
        
        # 4. Makespan by Task
        sns.boxplot(data=df, x='task_id', y='makespan', ax=axes[1, 0])
        axes[1, 0].set_title('Makespan by Task')
        axes[1, 0].set_ylabel('Makespan')
        axes[1, 0].tick_params(axis='x', rotation=45)
        
        # 5. Memory Usage by Framework
        if 'memory_usage' in df.columns and df['memory_usage'].sum() > 0:
            sns.boxplot(data=df, x='framework', y='memory_usage', ax=axes[1, 1])
            axes[1, 1].set_title('Memory Usage by Framework')
            axes[1, 1].set_ylabel('Memory Usage (MB)')
        
        # 6. Token Usage by Framework
        if 'token_usage' in df.columns and df['token_usage'].sum() > 0:
            sns.boxplot(data=df, x='framework', y='token_usage', ax=axes[1, 2])
            axes[1, 2].set_title('Token Usage by Framework')
            axes[1, 2].set_ylabel('Token Usage')
        
        plt.tight_layout()
        
        # Save the plot
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        plot_filename = f"{self.config.output_dir}/benchmark_visualization_{timestamp}.png"
        plt.savefig(plot_filename, dpi=300, bbox_inches='tight')
        plt.close()
        
        print(f"Visualization saved to {plot_filename}")
    
    def print_summary(self):
        """Print a summary of the benchmark results"""
        print("\n" + "="*60)
        print("REALM-Bench Evaluation Summary")
        print("="*60)
        
        for framework, results in self.results.items():
            print(f"\nFramework: {framework.upper()}")
            print("-" * 40)
            
            avg_goal_satisfaction = sum(r.metrics.get('goal_satisfaction_rate', 0) for r in results) / len(results)
            avg_constraint_satisfaction = sum(r.metrics.get('constraint_satisfaction_rate', 0) for r in results) / len(results)
            avg_execution_time = sum(r.execution_time for r in results) / len(results)
            
            print(f"Average Goal Satisfaction Rate: {avg_goal_satisfaction:.2f}%")
            print(f"Average Constraint Satisfaction Rate: {avg_constraint_satisfaction:.2f}%")
            print(f"Average Execution Time: {avg_execution_time:.2f} seconds")
            print(f"Tasks Completed: {len(results)}/{len(self.config.tasks)}")
        
        print("\n" + "="*60) 