# elizaOS Plugin Planning - Python

Comprehensive planning and execution plugin for elizaOS with REALM-Bench and API-Bank benchmarking.

## Features

- **Message Classification**: LLM-powered classification of message complexity
- **Simple Planning**: Quick plan generation for basic tasks
- **Comprehensive Planning**: Multi-step plans with dependency management
- **Execution Models**: Sequential, parallel, and DAG execution
- **Plan Validation**: Validates plans before execution
- **Plan Adaptation**: Adapts plans based on execution results
- **Benchmarking**: REALM-Bench and API-Bank test suites

## Installation

```bash
# Basic installation
pip install elizaos-plugin-planning

# With benchmarking dependencies
pip install elizaos-plugin-planning[benchmarks]

# Development installation
pip install -e ".[dev,benchmarks]"
```

## Usage

### Basic Planning

```python
from elizaos_plugin_planning import PlanningPlugin, PlanningService

# Initialize
plugin = PlanningPlugin()
await plugin.initialize(runtime)

# Create a simple plan
plan = await plugin.service.create_simple_plan(
    message={"content": {"text": "Research AI trends"}},
    state={},
)

# Execute the plan
result = await plugin.service.execute_plan(plan, message)
print(f"Success: {result.success}")
```

### Comprehensive Planning

```python
from elizaos_plugin_planning import PlanningService

service = PlanningService()
await service.start(runtime)

# Create a comprehensive plan
context = {
    "goal": "Build and deploy a web application",
    "constraints": [{"type": "time", "value": "2 hours"}],
    "available_actions": ["SEARCH", "CREATE_FILE", "DEPLOY"],
    "preferences": {
        "execution_model": "dag",
        "max_steps": 10,
    },
}

plan = await service.create_comprehensive_plan(context)

# Validate before execution
is_valid, issues = await service.validate_plan(plan)
if is_valid:
    result = await service.execute_plan(plan, message)
```

### Message Classification

```python
from elizaos_plugin_planning import MessageClassifierProvider

classifier = MessageClassifierProvider()
result = await classifier.get(runtime, message)

print(f"Classification: {result['data'].classification}")
print(f"Complexity: {result['data'].complexity}")
print(f"Planning Required: {result['data'].planning_required}")
```

## Benchmarking

### Running REALM-Bench Tests

```python
from elizaos_plugin_planning.benchmarks import BenchmarkRunner, BenchmarkConfig

config = BenchmarkConfig(
    realm_bench_path="./realm-bench-data",
    run_realm_bench=True,
    run_api_bank=False,
    output_dir="./benchmark_results",
)

runner = BenchmarkRunner(config)
results = await runner.run_benchmarks()

print(f"Overall Success Rate: {results.overall_metrics['overall_success_rate'] * 100:.1f}%")
```

### Running API-Bank Tests

```python
config = BenchmarkConfig(
    api_bank_path="./api-bank-data",
    run_realm_bench=False,
    run_api_bank=True,
    output_dir="./benchmark_results",
)

runner = BenchmarkRunner(config)
results = await runner.run_benchmarks()

if results.api_bank_results:
    print(f"API Call Accuracy: {results.api_bank_results.overall_metrics['average_api_call_accuracy'] * 100:.1f}%")
```

### Command Line

```bash
# Run all benchmarks
python -m elizaos_plugin_planning.benchmarks.cli --all

# Run only REALM-Bench
python -m elizaos_plugin_planning.benchmarks.cli --realm-bench

# Run with custom output
python -m elizaos_plugin_planning.benchmarks.cli --all --output ./my_results
```

## Configuration

| Setting              | Default    | Description               |
| -------------------- | ---------- | ------------------------- |
| `max_steps`          | 10         | Maximum steps in a plan   |
| `default_timeout_ms` | 60000      | Default execution timeout |
| `execution_model`    | sequential | Default execution model   |
| `enable_adaptation`  | true       | Enable plan adaptation    |

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/

# Run with coverage
pytest --cov=elizaos_plugin_planning tests/

# Type checking
mypy elizaos_plugin_planning/

# Formatting
black elizaos_plugin_planning/ tests/
ruff check elizaos_plugin_planning/
```

## License

MIT



