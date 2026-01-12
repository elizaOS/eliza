from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class BenchmarkConfig:
    realm_bench_path: Optional[str] = None
    api_bank_path: Optional[str] = None
    run_realm_bench: bool = True
    run_api_bank: bool = True
    max_tests_per_category: Optional[int] = None
    timeout_ms: int = 60000
    output_dir: str = "./benchmark_results"
    save_detailed_logs: bool = True
    enable_metrics: bool = True
    enable_memory_tracking: bool = True


@dataclass
class RealmBenchTask:
    id: str
    name: str
    description: str
    goal: str
    requirements: list[str]
    constraints: dict[str, Any]
    expected_outcome: str
    available_tools: list[str]
    timeout_ms: int = 60000
    max_steps: int = 10


@dataclass
class RealmBenchTestCase:
    task: RealmBenchTask
    input: dict[str, Any]
    expected: dict[str, Any]


@dataclass
class RealmBenchResult:
    test_case_id: str
    task_id: str
    success: bool
    duration: float
    steps_executed: int
    actions_performed: list[str]
    plan_generated: Optional[dict[str, Any]]
    error: Optional[str] = None
    metrics: dict[str, float] = field(
        default_factory=lambda: {
            "planning_time": 0.0,
            "execution_time": 0.0,
            "plan_quality": 0.0,
            "goal_achievement": 0.0,
            "efficiency": 0.0,
        }
    )
    details: dict[str, Any] = field(
        default_factory=lambda: {
            "plan_adaptations": 0,
            "error_recoveries": 0,
            "resource_usage": {},
        }
    )


@dataclass
class RealmBenchReport:
    total_tests: int
    passed_tests: int
    failed_tests: int
    average_duration: float
    average_steps: float
    average_plan_quality: float
    average_goal_achievement: float
    average_efficiency: float
    results: list[RealmBenchResult]
    summary: dict[str, Any] = field(
        default_factory=lambda: {
            "task_categories": {},
            "common_failures": [],
            "recommendations": [],
        }
    )


@dataclass
class ApiBankApi:
    name: str
    description: str
    parameters: list[dict[str, Any]]
    returns: str


@dataclass
class ApiBankApiCall:
    api: str
    parameters: dict[str, Any]


@dataclass
class ApiBankTestCase:
    """API-Bank test case."""

    id: str
    level: int  # 1, 2, or 3
    description: str
    query: str
    available_apis: list[ApiBankApi]
    expected_api_calls: list[ApiBankApiCall]
    expected_response: str


@dataclass
class ApiBankResult:
    test_case_id: str
    level: int
    success: bool
    duration: float
    api_calls_planned: list[ApiBankApiCall]
    api_calls_expected: list[ApiBankApiCall]
    response_generated: str
    response_expected: str
    error: Optional[str] = None
    metrics: dict[str, float] = field(
        default_factory=lambda: {
            "planning_time": 0.0,
            "execution_time": 0.0,
            "api_call_accuracy": 0.0,
            "parameter_accuracy": 0.0,
            "response_quality": 0.0,
        }
    )


@dataclass
class ApiBankReport:
    total_tests: int
    passed_tests: int
    failed_tests: int
    results: list[ApiBankResult]
    level_breakdown: dict[int, dict[str, Any]] = field(default_factory=dict)
    overall_metrics: dict[str, float] = field(
        default_factory=lambda: {
            "average_api_call_accuracy": 0.0,
            "average_parameter_accuracy": 0.0,
            "average_response_quality": 0.0,
        }
    )


@dataclass
class BenchmarkResults:
    metadata: dict[str, Any]
    realm_bench_results: Optional[RealmBenchReport] = None
    api_bank_results: Optional[ApiBankReport] = None
    overall_metrics: dict[str, Any] = field(
        default_factory=lambda: {
            "total_tests": 0,
            "total_passed": 0,
            "overall_success_rate": 0.0,
            "average_planning_time": 0.0,
            "average_execution_time": 0.0,
            "memory_usage": {"peak": 0, "average": 0},
        }
    )
    comparison: dict[str, Any] = field(
        default_factory=lambda: {
            "planning_vs_baseline": {"improvement_rate": 0.0, "categories": []},
            "strengths_and_weaknesses": {
                "strengths": [],
                "weaknesses": [],
                "recommendations": [],
            },
        }
    )
    summary: dict[str, Any] = field(
        default_factory=lambda: {
            "status": "pending",
            "key_findings": [],
            "performance_score": 0,
        }
    )
