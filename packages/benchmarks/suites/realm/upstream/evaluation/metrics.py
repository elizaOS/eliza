"""
Evaluation Metrics for Multi-Agent Planning

This module implements the standard evaluation metrics for multi-agent planning tasks:
1. Planning Quality (Accuracy) - Goal satisfaction
2. Planning Optimality (Makespan) - Cost/min-time schedule quality  
3. Coordination Effectiveness - Temporal or resource-based inter-agent consistency
4. Constraint Satisfaction Rate - Number/percent of constraints satisfied
5. Resource Usage Rate - Utilization of capacity-constrained assets
6. Adaptation to Disruption - Replanning success/convergence rate
"""

import time
import json
import math
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
import numpy as np


class MetricType(Enum):
    """Types of evaluation metrics"""
    PLANNING_QUALITY = "planning_quality"
    PLANNING_OPTIMALITY = "planning_optimality"
    COORDINATION_EFFECTIVENESS = "coordination_effectiveness"
    CONSTRAINT_SATISFACTION = "constraint_satisfaction"
    RESOURCE_USAGE = "resource_usage"
    ADAPTATION = "adaptation"


@dataclass
class MetricResult:
    """Result of a single metric evaluation"""
    metric_name: str
    metric_type: MetricType
    value: float
    unit: str
    description: str
    details: Dict[str, Any]
    timestamp: float


class BaseMetrics:
    """Base class for all evaluation metrics"""
    
    def __init__(self):
        self.results: List[MetricResult] = []
        self.start_time = time.time()
    
    def add_result(self, metric_name: str, metric_type: MetricType, 
                   value: float, unit: str, description: str, details: Dict[str, Any] = None):
        """Add a metric result"""
        result = MetricResult(
            metric_name=metric_name,
            metric_type=metric_type,
            value=value,
            unit=unit,
            description=description,
            details=details or {},
            timestamp=time.time()
        )
        self.results.append(result)
        return result
    
    def get_results(self) -> List[MetricResult]:
        """Get all metric results"""
        return self.results
    
    def export_results(self, filepath: str):
        """Export results to JSON file"""
        data = {
            "results": [
                {
                    "metric_name": r.metric_name,
                    "metric_type": r.metric_type.value,
                    "value": r.value,
                    "unit": r.unit,
                    "description": r.description,
                    "details": r.details,
                    "timestamp": r.timestamp
                }
                for r in self.results
            ],
            "total_time": time.time() - self.start_time
        }
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)


class PlanningQualityMetrics(BaseMetrics):
    """Planning Quality (Accuracy) - Goal satisfaction metrics"""
    
    def evaluate_goal_satisfaction(self, 
                                 expected_goals: List[str],
                                 achieved_goals: List[str],
                                 goal_weights: Optional[Dict[str, float]] = None) -> MetricResult:
        """
        Evaluate goal satisfaction rate
        
        Args:
            expected_goals: List of expected goals
            achieved_goals: List of achieved goals  
            goal_weights: Optional weights for different goals
        """
        if not expected_goals:
            return self.add_result(
                "goal_satisfaction_rate", MetricType.PLANNING_QUALITY,
                0.0, "percentage", "No goals to evaluate"
            )
        
        # Calculate weighted goal satisfaction
        if goal_weights:
            total_weight = sum(goal_weights.values())
            satisfied_weight = sum(
                goal_weights.get(goal, 1.0) 
                for goal in achieved_goals 
                if goal in expected_goals
            )
            satisfaction_rate = (satisfied_weight / total_weight) * 100
        else:
            # Simple percentage
            satisfied_goals = len(set(achieved_goals) & set(expected_goals))
            satisfaction_rate = (satisfied_goals / len(expected_goals)) * 100
        
        return self.add_result(
            "goal_satisfaction_rate", MetricType.PLANNING_QUALITY,
            satisfaction_rate, "percentage", 
            f"Goal satisfaction rate: {satisfaction_rate:.2f}%",
            {
                "expected_goals": expected_goals,
                "achieved_goals": achieved_goals,
                "satisfied_goals": list(set(achieved_goals) & set(expected_goals))
            }
        )
    
    def evaluate_plan_completeness(self, 
                                 required_actions: List[str],
                                 executed_actions: List[str]) -> MetricResult:
        """Evaluate plan completeness"""
        if not required_actions:
            return self.add_result(
                "plan_completeness", MetricType.PLANNING_QUALITY,
                100.0, "percentage", "No actions required"
            )
        
        completed_actions = len(set(executed_actions) & set(required_actions))
        completeness = (completed_actions / len(required_actions)) * 100
        
        return self.add_result(
            "plan_completeness", MetricType.PLANNING_QUALITY,
            completeness, "percentage",
            f"Plan completeness: {completeness:.2f}%",
            {
                "required_actions": required_actions,
                "executed_actions": executed_actions,
                "completed_actions": list(set(executed_actions) & set(required_actions))
            }
        )


class PlanningOptimalityMetrics(BaseMetrics):
    """Planning Optimality (Makespan) - Cost/min-time schedule quality metrics"""
    
    def evaluate_makespan(self, 
                         schedule: List[Dict[str, Any]],
                         optimal_makespan: Optional[float] = None) -> MetricResult:
        """
        Evaluate makespan (total completion time)
        
        Args:
            schedule: List of scheduled tasks with start/end times
            optimal_makespan: Known optimal makespan for comparison
        """
        if not schedule:
            return self.add_result(
                "makespan", MetricType.PLANNING_OPTIMALITY,
                0.0, "time_units", "No schedule to evaluate"
            )
        
        # Calculate actual makespan
        end_times = [task.get('end_time', 0) for task in schedule if task.get('end_time') is not None]
        actual_makespan = max(end_times) if end_times else 0
        
        details = {
            "schedule": schedule,
            "actual_makespan": actual_makespan
        }
        
        # Compare with optimal if provided
        if optimal_makespan is not None:
            optimality_ratio = optimal_makespan / actual_makespan if actual_makespan > 0 else 0
            details["optimal_makespan"] = optimal_makespan
            details["optimality_ratio"] = optimality_ratio
            
            return self.add_result(
                "makespan_optimality", MetricType.PLANNING_OPTIMALITY,
                optimality_ratio, "ratio",
                f"Makespan optimality ratio: {optimality_ratio:.3f}",
                details
            )
        
        return self.add_result(
            "makespan", MetricType.PLANNING_OPTIMALITY,
            actual_makespan, "time_units",
            f"Total makespan: {actual_makespan}",
            details
        )
    
    def evaluate_cost_efficiency(self, 
                               actual_cost: float,
                               optimal_cost: Optional[float] = None,
                               budget: Optional[float] = None) -> MetricResult:
        """Evaluate cost efficiency"""
        details = {"actual_cost": actual_cost}
        
        if optimal_cost is not None and actual_cost is not None:
            efficiency = optimal_cost / actual_cost if actual_cost > 0 else 0
            details["optimal_cost"] = optimal_cost
            details["efficiency_ratio"] = efficiency
            
            return self.add_result(
                "cost_efficiency", MetricType.PLANNING_OPTIMALITY,
                efficiency, "ratio",
                f"Cost efficiency ratio: {efficiency:.3f}",
                details
            )
        
        if budget is not None and actual_cost is not None:
            budget_utilization = (actual_cost / budget) * 100
            details["budget"] = budget
            details["budget_utilization"] = budget_utilization
            
            return self.add_result(
                "budget_utilization", MetricType.PLANNING_OPTIMALITY,
                budget_utilization, "percentage",
                f"Budget utilization: {budget_utilization:.2f}%",
                details
            )
        
        return self.add_result(
            "total_cost", MetricType.PLANNING_OPTIMALITY,
            actual_cost, "cost_units",
            f"Total cost: {actual_cost}",
            details
        )


class CoordinationEffectivenessMetrics(BaseMetrics):
    """Coordination Effectiveness - Temporal or resource-based inter-agent consistency metrics"""
    
    def evaluate_temporal_consistency(self, 
                                    agent_schedules: Dict[str, List[Dict[str, Any]]],
                                    dependencies: List[Tuple[str, str]]) -> MetricResult:
        """
        Evaluate temporal consistency between agents
        
        Args:
            agent_schedules: Dict mapping agent_id to list of scheduled tasks
            dependencies: List of (predecessor, successor) task dependencies
        """
        if not dependencies:
            return self.add_result(
                "temporal_consistency", MetricType.COORDINATION_EFFECTIVENESS,
                100.0, "percentage", "No dependencies to check"
            )
        
        violations = 0
        total_dependencies = len(dependencies)
        
        for pred_task, succ_task in dependencies:
            pred_end = self._get_task_end_time(pred_task, agent_schedules)
            succ_start = self._get_task_start_time(succ_task, agent_schedules)
            
            # Handle None values safely
            if pred_end is not None and succ_start is not None and pred_end > succ_start:
                violations += 1
        
        consistency_rate = ((total_dependencies - violations) / total_dependencies) * 100
        
        return self.add_result(
            "temporal_consistency", MetricType.COORDINATION_EFFECTIVENESS,
            consistency_rate, "percentage",
            f"Temporal consistency: {consistency_rate:.2f}%",
            {
                "dependencies": dependencies,
                "violations": violations,
                "total_dependencies": total_dependencies
            }
        )
    
    def evaluate_resource_consistency(self, 
                                    resource_usage: Dict[str, List[Dict[str, Any]]],
                                    resource_capacity: Dict[str, float]) -> MetricResult:
        """Evaluate resource usage consistency"""
        if not resource_usage:
            return self.add_result(
                "resource_consistency", MetricType.COORDINATION_EFFECTIVENESS,
                100.0, "percentage", "No resource usage to check"
            )
        
        violations = 0
        total_checks = 0
        
        for resource_id, usage_timeline in resource_usage.items():
            capacity = resource_capacity.get(resource_id, float('inf'))
            
            for usage in usage_timeline:
                total_checks += 1
                amount = usage.get('amount', 0)
                if amount is not None and capacity is not None and amount > capacity:
                    violations += 1
        
        consistency_rate = ((total_checks - violations) / total_checks) * 100 if total_checks > 0 else 100
        
        return self.add_result(
            "resource_consistency", MetricType.COORDINATION_EFFECTIVENESS,
            consistency_rate, "percentage",
            f"Resource consistency: {consistency_rate:.2f}%",
            {
                "resource_usage": resource_usage,
                "resource_capacity": resource_capacity,
                "violations": violations,
                "total_checks": total_checks
            }
        )
    
    def _get_task_end_time(self, task_id: str, agent_schedules: Dict[str, List[Dict[str, Any]]]) -> float:
        """Helper to get task end time"""
        for agent_id, schedule in agent_schedules.items():
            for task in schedule:
                if task.get('task_id') == task_id:
                    return task.get('end_time', 0)
        return 0
    
    def _get_task_start_time(self, task_id: str, agent_schedules: Dict[str, List[Dict[str, Any]]]) -> float:
        """Helper to get task start time"""
        for agent_id, schedule in agent_schedules.items():
            for task in schedule:
                if task.get('task_id') == task_id:
                    return task.get('start_time', 0)
        return 0


class ConstraintSatisfactionMetrics(BaseMetrics):
    """Constraint Satisfaction Rate - Number/percent of constraints satisfied"""
    
    def evaluate_constraint_satisfaction(self, 
                                       constraints: List[Dict[str, Any]],
                                       execution_results: Dict[str, Any]) -> MetricResult:
        """
        Evaluate constraint satisfaction rate
        
        Args:
            constraints: List of constraint definitions
            execution_results: Results from plan execution
        """
        if not constraints:
            return self.add_result(
                "constraint_satisfaction_rate", MetricType.CONSTRAINT_SATISFACTION,
                100.0, "percentage", "No constraints to evaluate"
            )
        
        satisfied_constraints = 0
        constraint_details = []
        
        for constraint in constraints:
            constraint_type = constraint.get('type', 'unknown')
            constraint_id = constraint.get('id', 'unknown')
            
            is_satisfied = self._check_constraint(constraint, execution_results)
            constraint_details.append({
                'id': constraint_id,
                'type': constraint_type,
                'satisfied': is_satisfied,
                'description': constraint.get('description', '')
            })
            
            if is_satisfied:
                satisfied_constraints += 1
        
        satisfaction_rate = (satisfied_constraints / len(constraints)) * 100
        
        return self.add_result(
            "constraint_satisfaction_rate", MetricType.CONSTRAINT_SATISFACTION,
            satisfaction_rate, "percentage",
            f"Constraint satisfaction rate: {satisfaction_rate:.2f}%",
            {
                "constraints": constraint_details,
                "satisfied_count": satisfied_constraints,
                "total_count": len(constraints)
            }
        )
    
    def _check_constraint(self, constraint: Dict[str, Any], results: Dict[str, Any]) -> bool:
        """Check if a specific constraint is satisfied"""
        constraint_type = constraint.get('type', 'unknown')
        
        if constraint_type == 'deadline':
            return self._check_deadline_constraint(constraint, results)
        elif constraint_type == 'dependency':
            return self._check_dependency_constraint(constraint, results)
        elif constraint_type == 'resource':
            return self._check_resource_constraint(constraint, results)
        elif constraint_type == 'capacity':
            return self._check_capacity_constraint(constraint, results)
        else:
            # Default: assume satisfied if not specified
            return True
    
    def _check_deadline_constraint(self, constraint: Dict[str, Any], results: Dict[str, Any]) -> bool:
        """Check deadline constraint"""
        task_id = constraint.get('task_id')
        deadline = constraint.get('deadline')
        
        if task_id in results.get('task_completion_times', {}):
            completion_time = results['task_completion_times'][task_id]
            if completion_time is not None and deadline is not None:
                return completion_time <= deadline
        return False
    
    def _check_dependency_constraint(self, constraint: Dict[str, Any], results: Dict[str, Any]) -> bool:
        """Check dependency constraint"""
        predecessor = constraint.get('predecessor')
        successor = constraint.get('successor')
        
        completion_times = results.get('task_completion_times', {})
        if predecessor in completion_times and successor in completion_times:
            pred_time = completion_times[predecessor]
            succ_time = completion_times[successor]
            if pred_time is not None and succ_time is not None:
                return pred_time <= succ_time
        return False
    
    def _check_resource_constraint(self, constraint: Dict[str, Any], results: Dict[str, Any]) -> bool:
        """Check resource constraint"""
        resource_id = constraint.get('resource_id')
        max_usage = constraint.get('max_usage')
        
        resource_usage = results.get('resource_usage', {}).get(resource_id, 0)
        if resource_usage is not None and max_usage is not None:
            return resource_usage <= max_usage
        return False
    
    def _check_capacity_constraint(self, constraint: Dict[str, Any], results: Dict[str, Any]) -> bool:
        """Check capacity constraint"""
        capacity_id = constraint.get('capacity_id')
        max_capacity = constraint.get('max_capacity')
        
        current_usage = results.get('capacity_usage', {}).get(capacity_id, 0)
        if current_usage is not None and max_capacity is not None:
            return current_usage <= max_capacity
        return False


class ResourceUsageMetrics(BaseMetrics):
    """Resource Usage Rate - Utilization of capacity-constrained assets"""
    
    def evaluate_memory_usage(self, 
                            memory_usage: List[Dict[str, Any]],
                            memory_limit: Optional[float] = None) -> MetricResult:
        """Evaluate memory usage patterns"""
        if not memory_usage:
            return self.add_result(
                "memory_usage", MetricType.RESOURCE_USAGE,
                0.0, "MB", "No memory usage data"
            )
        
        peak_memory = max(usage.get('memory_mb', 0) for usage in memory_usage)
        avg_memory = np.mean([usage.get('memory_mb', 0) for usage in memory_usage])
        
        details = {
            "memory_usage": memory_usage,
            "peak_memory": peak_memory,
            "average_memory": avg_memory
        }
        
        if memory_limit is not None:
            utilization_rate = (peak_memory / memory_limit) * 100
            details["memory_limit"] = memory_limit
            details["utilization_rate"] = utilization_rate
            
            return self.add_result(
                "memory_utilization", MetricType.RESOURCE_USAGE,
                utilization_rate, "percentage",
                f"Memory utilization: {utilization_rate:.2f}%",
                details
            )
        
        return self.add_result(
            "peak_memory_usage", MetricType.RESOURCE_USAGE,
            peak_memory, "MB",
            f"Peak memory usage: {peak_memory:.2f} MB",
            details
        )
    
    def evaluate_time_usage(self, 
                          execution_times: List[float],
                          time_limit: Optional[float] = None) -> MetricResult:
        """Evaluate time usage patterns"""
        if not execution_times:
            return self.add_result(
                "time_usage", MetricType.RESOURCE_USAGE,
                0.0, "seconds", "No execution time data"
            )
        
        total_time = sum(execution_times)
        avg_time = np.mean(execution_times)
        
        details = {
            "execution_times": execution_times,
            "total_time": total_time,
            "average_time": avg_time
        }
        
        if time_limit is not None:
            utilization_rate = (total_time / time_limit) * 100
            details["time_limit"] = time_limit
            details["utilization_rate"] = utilization_rate
            
            return self.add_result(
                "time_utilization", MetricType.RESOURCE_USAGE,
                utilization_rate, "percentage",
                f"Time utilization: {utilization_rate:.2f}%",
                details
            )
        
        return self.add_result(
            "total_execution_time", MetricType.RESOURCE_USAGE,
            total_time, "seconds",
            f"Total execution time: {total_time:.2f} seconds",
            details
        )
    
    def evaluate_token_usage(self, 
                           token_usage: Dict[str, int],
                           token_limit: Optional[int] = None) -> MetricResult:
        """Evaluate LLM token usage"""
        if not token_usage:
            return self.add_result(
                "token_usage", MetricType.RESOURCE_USAGE,
                0, "tokens", "No token usage data"
            )
        
        total_tokens = sum(token_usage.values())
        
        details = {
            "token_usage": token_usage,
            "total_tokens": total_tokens
        }
        
        if token_limit is not None:
            utilization_rate = (total_tokens / token_limit) * 100
            details["token_limit"] = token_limit
            details["utilization_rate"] = utilization_rate
            
            return self.add_result(
                "token_utilization", MetricType.RESOURCE_USAGE,
                utilization_rate, "percentage",
                f"Token utilization: {utilization_rate:.2f}%",
                details
            )
        
        return self.add_result(
            "total_token_usage", MetricType.RESOURCE_USAGE,
            total_tokens, "tokens",
            f"Total token usage: {total_tokens}",
            details
        )


class AdaptationMetrics(BaseMetrics):
    """Adaptation to Disruption - Replanning success/convergence rate"""
    
    def evaluate_replanning_success(self, 
                                  disruptions: List[Dict[str, Any]],
                                  replanning_results: List[Dict[str, Any]]) -> MetricResult:
        """
        Evaluate replanning success rate
        
        Args:
            disruptions: List of disruption events
            replanning_results: Results of replanning attempts
        """
        if not disruptions:
            return self.add_result(
                "replanning_success_rate", MetricType.ADAPTATION,
                100.0, "percentage", "No disruptions to handle"
            )
        
        successful_replans = 0
        replan_details = []
        
        for i, disruption in enumerate(disruptions):
            replan_result = replanning_results[i] if i < len(replanning_results) else {}
            
            is_successful = replan_result.get('success', False)
            replan_details.append({
                'disruption_id': disruption.get('id'),
                'disruption_type': disruption.get('type'),
                'successful': is_successful,
                'replan_time': replan_result.get('replan_time', 0),
                'solution_quality': replan_result.get('solution_quality', 0)
            })
            
            if is_successful:
                successful_replans += 1
        
        success_rate = (successful_replans / len(disruptions)) * 100
        
        return self.add_result(
            "replanning_success_rate", MetricType.ADAPTATION,
            success_rate, "percentage",
            f"Replanning success rate: {success_rate:.2f}%",
            {
                "disruptions": disruptions,
                "replan_details": replan_details,
                "successful_count": successful_replans,
                "total_count": len(disruptions)
            }
        )
    
    def evaluate_convergence_rate(self, 
                                replanning_iterations: List[Dict[str, Any]],
                                convergence_threshold: float = 0.01) -> MetricResult:
        """Evaluate convergence rate of replanning"""
        if not replanning_iterations or len(replanning_iterations) < 2:
            return self.add_result(
                "convergence_rate", MetricType.ADAPTATION,
                0.0, "iterations", "Insufficient data for convergence analysis"
            )
        
        # Calculate improvement between iterations
        improvements = []
        for i in range(1, len(replanning_iterations)):
            prev_quality = replanning_iterations[i-1].get('solution_quality', 0)
            curr_quality = replanning_iterations[i].get('solution_quality', 0)
            improvement = abs(curr_quality - prev_quality)
            improvements.append(improvement)
        
        # Check convergence
        converged = any(imp is not None and imp < convergence_threshold for imp in improvements)
        convergence_iteration = None
        
        if converged:
            for i, imp in enumerate(improvements):
                if imp is not None and imp < convergence_threshold:
                    convergence_iteration = i + 1
                    break
        
        return self.add_result(
            "convergence_rate", MetricType.ADAPTATION,
            convergence_iteration or len(replanning_iterations), "iterations",
            f"Convergence in {convergence_iteration or len(replanning_iterations)} iterations",
            {
                "replanning_iterations": replanning_iterations,
                "improvements": improvements,
                "converged": converged,
                "convergence_threshold": convergence_threshold
            }
        )
    
    def evaluate_disruption_recovery_time(self, 
                                        disruption_times: List[float],
                                        recovery_times: List[float]) -> MetricResult:
        """Evaluate time to recover from disruptions"""
        if not disruption_times or not recovery_times:
            return self.add_result(
                "recovery_time", MetricType.ADAPTATION,
                0.0, "seconds", "No disruption/recovery data"
            )
        
        recovery_durations = [
            recovery_times[i] - disruption_times[i] 
            for i in range(min(len(disruption_times), len(recovery_times)))
        ]
        
        avg_recovery_time = np.mean(recovery_durations)
        max_recovery_time = max(recovery_durations)
        
        return self.add_result(
            "average_recovery_time", MetricType.ADAPTATION,
            avg_recovery_time, "seconds",
            f"Average recovery time: {avg_recovery_time:.2f} seconds",
            {
                "disruption_times": disruption_times,
                "recovery_times": recovery_times,
                "recovery_durations": recovery_durations,
                "max_recovery_time": max_recovery_time
            }
        ) 