# REALM-Bench Evaluation Framework

This directory contains the comprehensive evaluation framework for REALM-Bench, providing standardized metrics and evaluation procedures for multi-agent planning tasks across different frameworks.

## Overview

The evaluation framework implements **6 standard evaluation metrics** for multi-agent planning:

1. **Planning Quality (Accuracy)** – Goal satisfaction
2. **Planning Optimality (Makespan)** – Cost/min-time schedule quality  
3. **Coordination Effectiveness** – Temporal or resource-based inter-agent consistency
4. **Constraint Satisfaction Rate** – Number/percent of constraints satisfied
5. **Resource Usage Rate** – Utilization of capacity-constrained assets (memory, time, tokens)
6. **Adaptation to Disruption** – Replanning success/convergence rate

## Supported Frameworks

- **LangGraph** - State machine-based agent orchestration
- **AutoGen** - Conversational AI framework
- **CrewAI** - Multi-agent collaboration framework
- **OpenAI Swarm Agent** - Swarm-based agent coordination

## Supported Tasks

The framework evaluates **11 real-world planning scenarios**:


- **P1**: Single-Agent Campus Tour - Routing with time windows
- **P2**: Multi-Group Campus Tours - Multi-agent scheduling
- **P3**: Urban Ride-Sharing (URS) - Vehicle routing with deadlines
- **P4**: URS with Disruptions - Dynamic routing with traffic delays
- **P5**: Wedding Logistics - Event coordination and scheduling
- **P6**: Thanksgiving Dinner Planning - Family coordination with dependencies
- **P7**: Disaster Relief Deployment - Resource allocation under uncertainty
- **P8**: Wedding Logistics with Disruptions - Reactive replanning
- **P9**: Thanksgiving Dinner with Disruptions - Flight delay adaptation
- **P10**: Global GPU Supply Chain - Large-scale industrial planning
- **P11**: Job Shop Scheduling (JSSP) - Canonical combinatorial optimization

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Run Full Benchmark

```bash
python run_evaluation.py
```

### 3. Run Specific Frameworks/Tasks

```bash
# Run only LangGraph and CrewAI
python run_evaluation.py --frameworks langgraph,crewai

# Run only specific tasks
python run_evaluation.py --tasks P11,P1,P2

# Run with mock runners for testing
python run_evaluation.py --mock
```

### 4. Custom Configuration

```bash
# Run with custom settings
python run_evaluation.py \
    --frameworks langgraph,autogen \
    --tasks P11,P1,P2,P3 \
    --runs 5 \
    --timeout 600 \
    --output-dir my_results \
    --no-viz
```

## Output Structure

The evaluation generates comprehensive results in the specified output directory:

```
evaluation_results/
├── langgraph_results_20241201_143022.json    # Detailed LangGraph results
├── autogen_results_20241201_143022.json      # Detailed AutoGen results
├── crewai_results_20241201_143022.json       # Detailed CrewAI results
├── swarm_results_20241201_143022.json        # Detailed Swarm results
├── benchmark_summary_20241201_143022.json    # Summary statistics
├── benchmark_results_20241201_143022.csv     # CSV for analysis
└── benchmark_visualization_20241201_143022.png # Performance plots
```

## Metrics Details

### 1. Planning Quality Metrics

- **Goal Satisfaction Rate**: Percentage of expected goals achieved
- **Plan Completeness**: Percentage of required actions executed

### 2. Planning Optimality Metrics

- **Makespan**: Total completion time of all tasks
- **Cost Efficiency**: Comparison with optimal cost
- **Budget Utilization**: Percentage of budget used

### 3. Coordination Effectiveness Metrics

- **Temporal Consistency**: Adherence to task dependencies
- **Resource Consistency**: Resource capacity constraint satisfaction

### 4. Constraint Satisfaction Metrics

- **Deadline Constraints**: Meeting time-based requirements
- **Dependency Constraints**: Maintaining task precedence
- **Resource Constraints**: Staying within resource limits
- **Capacity Constraints**: Respecting capacity limitations

### 5. Resource Usage Metrics

- **Memory Usage**: Peak and average memory consumption
- **Execution Time**: Total and per-task execution times
- **Token Usage**: LLM token consumption tracking

### 6. Adaptation Metrics

- **Replanning Success Rate**: Successful adaptation to disruptions
- **Convergence Rate**: Speed of replanning convergence
- **Recovery Time**: Time to recover from disruptions

## Framework Integration

### Adding New Frameworks

To add support for a new framework:

1. Create a new runner class in `framework_runners.py`:

```python
class NewFrameworkRunner(BaseFrameworkRunner):
    def __init__(self):
        super().__init__()
        # Initialize framework-specific components
    
    def __call__(self, task_definition: TaskDefinition) -> Dict[str, Any]:
        # Execute task using the framework
        # Return standardized result format
        pass
```

2. Register the runner in `get_framework_runners()`:

```python
def get_framework_runners() -> Dict[str, BaseFrameworkRunner]:
    runners = {}
    # ... existing runners ...
    
    try:
        runners['new_framework'] = NewFrameworkRunner()
    except Exception as e:
        print(f"New framework runner not available: {e}")
    
    return runners
```

### Framework Output Format

All frameworks must return results in this standardized format:

```python
{
    'achieved_goals': List[str],           # List of achieved goal IDs
    'satisfied_constraints': List[str],    # List of satisfied constraint IDs
    'schedule': List[Dict[str, Any]],      # Task schedule with timing
    'disruptions_handled': List[Dict],     # Disruptions encountered and handled
    'replanning_attempts': List[Dict],     # Replanning attempts made
    'resource_usage': {
        'memory_usage': List[Dict],        # Memory usage over time
        'execution_times': List[float],    # Execution times
        'token_usage': Dict[str, int]      # Token usage by component
    }
}
```

## Task Definition Format

Tasks are defined using the `TaskDefinition` class:

```python
TaskDefinition(
    task_id="P11",
    name="Job Shop Scheduling",
    category=TaskCategory.SCHEDULING,
    description="Canonical combinatorial optimization task",
    goals=[
        TaskGoal("minimize_makespan", "Minimize total completion time", 0.4),
        TaskGoal("minimize_idle_time", "Minimize machine idle time", 0.3)
    ],
    constraints=[
        TaskConstraint("job_precedence", "dependency", "Jobs must follow precedence", 
                      {"job_sequence": ["job1", "job2"]}),
        TaskConstraint("deadline", "deadline", "All jobs must complete by deadline", 
                      {"deadline": 100})
    ],
    resources={
        "machines": 3,
        "jobs": 5,
        "processing_times": [[2, 3, 1], [4, 2, 3]]
    },
    evaluation_weights={
        "planning_quality": 0.3,
        "planning_optimality": 0.4,
        "coordination_effectiveness": 0.1,
        "constraint_satisfaction": 0.2
    }
)
```

## Analysis and Visualization

The framework automatically generates:

1. **Performance Plots**: Box plots comparing frameworks across metrics
2. **Summary Statistics**: Average performance by framework
3. **Detailed Results**: JSON files with complete execution data
4. **CSV Export**: Tabular data for further analysis

### Custom Analysis

You can load the results for custom analysis:

```python
import pandas as pd
import json

# Load CSV results
df = pd.read_csv('evaluation_results/benchmark_results_20241201_143022.csv')

# Load detailed results
with open('evaluation_results/langgraph_results_20241201_143022.json', 'r') as f:
    langgraph_results = json.load(f)

# Analyze specific metrics
goal_satisfaction = df.groupby('framework')['goal_satisfaction_rate'].mean()
execution_times = df.groupby('framework')['execution_time'].mean()
```

## Troubleshooting

### Common Issues

1. **Framework Import Errors**: Ensure all framework dependencies are installed
2. **Memory Issues**: Reduce number of concurrent runs or increase system memory
3. **Timeout Errors**: Increase timeout value or optimize framework performance
4. **Missing Results**: Check framework runner implementation and error handling

### Debug Mode

Run with verbose output for debugging:

```bash
python run_evaluation.py --verbose --mock
```

### Testing with Mock Runners

Use mock runners to test the evaluation framework without actual frameworks:

```bash
python run_evaluation.py --mock --tasks P0,P1
```

## Contributing

To contribute to the evaluation framework:

1. **Add New Metrics**: Extend the metrics classes in `metrics.py`
2. **Add New Tasks**: Define new tasks in `task_definitions.py`
3. **Improve Runners**: Enhance framework integration in `framework_runners.py`
4. **Add Visualizations**: Extend plotting capabilities in `evaluator.py`

## Citation

If you use this evaluation framework, please cite:

```bibtex
@article{realmbench2024,
  title={REALM-Bench: A Real-World Planning Benchmark for LLMs and Multi-Agent Systems},
  author={Anonymous Author(s)},
  journal={arXiv preprint},
  year={2024}
}
``` 