# ElizaOS Scenario & Report Commands - Complete Configuration Specification

This document provides a comprehensive reference for using the ElizaOS scenario and report commands, including all configuration options, command-line flags, and practical examples.

## Table of Contents

1. [Overview](#overview)
2. [Scenario Command](#scenario-command)
3. [Scenario File Configuration (.scenario.yaml)](#scenario-file-configuration-scenarioyaml)
4. [Matrix Configuration (.matrix.yaml)](#matrix-configuration-matrixyaml)
5. [Report Command](#report-command)
6. [Examples](#examples)
7. [Best Practices](#best-practices)

## Overview

The ElizaOS CLI provides two main testing and analysis commands:
- **`elizaos scenario`** - Execute individual scenarios or scenario matrices for testing agent behavior
- **`elizaos report`** - Generate comprehensive reports from scenario execution results

Both commands work together to provide a complete testing and analysis workflow for ElizaOS agents.

---

## Scenario Command

### `elizaos scenario run`

Execute a single scenario from a YAML file.

#### Syntax
```bash
elizaos scenario run <filePath> [options]
```

#### Arguments
- **`<filePath>`** _(required)_ - Path to the .scenario.yaml file

#### Options
- **`-l, --live`** - Run scenario in live mode, ignoring mocks (default: false)

#### Examples
```bash
# Basic scenario execution
elizaos scenario run ./tests/basic-test.scenario.yaml

# Live mode execution (no mocks)
elizaos scenario run ./tests/integration-test.scenario.yaml --live
```

### `elizaos scenario matrix`

Execute a scenario matrix from a configuration file.

#### Syntax
```bash
elizaos scenario matrix <configPath> [options]
```

#### Arguments
- **`<configPath>`** _(required)_ - Path to the matrix configuration .yaml file

#### Options
- **`--dry-run`** - Show matrix analysis without executing tests (default: false)
- **`--parallel <number>`** - Maximum number of parallel test runs (default: "1")
- **`--filter <pattern>`** - Filter parameter combinations by pattern
- **`--verbose`** - Show detailed progress information (default: false)

#### Examples
```bash
# Basic matrix execution
elizaos scenario matrix ./tests/llm-robustness.matrix.yaml

# Dry run to analyze matrix without execution
elizaos scenario matrix ./tests/complex-matrix.yaml --dry-run

# Parallel execution with filtering
elizaos scenario matrix ./tests/performance.matrix.yaml --parallel 4 --filter "temperature.*0.5"

# Verbose execution for debugging
elizaos scenario matrix ./tests/debug-matrix.yaml --verbose
```

---

## Scenario File Configuration (.scenario.yaml)

### Root Schema

```yaml
name: string                    # Required: Human-readable scenario name
description: string             # Required: Detailed description of the scenario
plugins: PluginReference[]     # Optional: Array of plugin configurations
environment:                   # Required: Environment configuration
  type: "e2b" | "local"        # Required: Environment type
setup:                         # Optional: Setup configuration
  mocks: Mock[]               # Optional: Array of mock definitions
  virtual_fs: Record<string, string>  # Optional: Virtual file system
run: RunStep[]                 # Required: Array of execution steps
judgment:                      # Required: Evaluation strategy
  strategy: "all_pass" | "any_pass"  # Required: How to judge overall success
```

### Plugin Configuration

Plugins can be specified as simple strings or detailed configuration objects:

```yaml
plugins:
  # Simple string reference
  - "@elizaos/plugin-bootstrap"
  
  # Full configuration object
  - name: "@elizaos/plugin-github"
    version: "1.0.0"           # Optional: Specific version
    enabled: true              # Optional: Enable/disable plugin (default: true)
    config:                    # Optional: Plugin-specific configuration
      api_key: "github_token"
      rate_limit: 100
```

### Environment Configuration

#### Local Environment
```yaml
environment:
  type: local
```

#### E2B Environment
```yaml
environment:
  type: e2b
```

### Setup Configuration

#### Mocks
Mock external services and API calls:

```yaml
setup:
  mocks:
    - service: "github"                    # Optional: Service name
      method: "listIssues"                # Required: Method to mock
      when:                              # Optional: Condition matching
        args: [["owner", "repo"]]        # Exact argument matching
        input:                           # Input parameter matching
          owner: "elizaos"
          repo: "eliza"
        context:                         # Request context matching
          user_id: "123"
        matcher: "args[0].includes('test')"  # JavaScript matcher function
        partialArgs: ["elizaos"]         # Partial argument matching
      response:                          # Static response
        issues: [{"title": "Test Issue", "id": 1}]
      responseFn: "() => ({ timestamp: Date.now() })"  # Dynamic response
      error:                             # Error simulation
        code: "API_ERROR"
        message: "Rate limit exceeded"
        status: 429
      metadata:                          # Response metadata
        delay: 1000                      # Network delay simulation (ms)
        probability: 0.1                 # Random failure rate (0-1)
```

#### Virtual File System
Create virtual files for testing:

```yaml
setup:
  virtual_fs:
    "config.json": '{"api_key": "test_key"}'
    "data.txt": "Sample data content"
    "nested/file.yaml": |
      key: value
      array: [1, 2, 3]
```

### Run Steps

Each run step defines an execution unit with evaluations:

```yaml
run:
  - name: "Step Description"            # Optional: Human-readable step name
    lang: "bash"                        # Optional: Language for code execution
    code: |                             # Optional: Code to execute
      echo "Hello World"
      cat config.json
    input: "Natural language prompt"    # Optional: Input to send to agent
    evaluations:                        # Required: Array of evaluation criteria
      - type: "string_contains"
        value: "expected text"
        case_sensitive: false           # Optional: Case sensitivity (default: true)
```

### Evaluation Types

#### String Contains
```yaml
- type: "string_contains"
  value: "expected text"
  case_sensitive: false                 # Optional: default true
```

#### Regex Match
```yaml
- type: "regex_match"
  pattern: "\\d{4}-\\d{2}-\\d{2}"      # Regex pattern
```

#### File Exists
```yaml
- type: "file_exists"
  path: "output/result.json"           # File path to check
```

#### Trajectory Contains Action
```yaml
- type: "trajectory_contains_action"
  action: "LIST_GITHUB_ISSUES"         # Action name to verify in trajectory
```

#### LLM Judge
Advanced AI-powered evaluation:

```yaml
- type: "llm_judge"
  prompt: "Does the output show successful JSON processing?"
  expected: "yes"                      # Expected judgment
  model_type: "TEXT_LARGE"            # Optional: LLM model type
  temperature: 0.1                     # Optional: Temperature (0-2)
  json_schema:                         # Optional: Structured output schema
    type: "object"
    properties:
      judgment:
        type: "string"
        enum: ["yes", "no"]
      confidence:
        type: "number"
        minimum: 0
        maximum: 1
      reasoning:
        type: "string"
    required: ["judgment", "confidence", "reasoning"]
  capabilities:                        # Optional: Custom capability checklist
    - "Understands multi-step requests"
    - "Provides accurate summaries"
    - "Formats output clearly"
```

#### Execution Time
```yaml
- type: "execution_time"
  max_duration_ms: 5000               # Maximum allowed duration
  min_duration_ms: 100                # Optional: Minimum duration
  target_duration_ms: 2000            # Optional: Target duration
```

### Judgment Strategy

Determines how overall scenario success is calculated:

```yaml
judgment:
  strategy: "all_pass"    # All evaluations must pass
  # OR
  strategy: "any_pass"    # At least one evaluation must pass
```

---

## Matrix Configuration (.matrix.yaml)

### Root Schema

```yaml
name: string                    # Required: Matrix name
description: string             # Optional: Matrix description
base_scenario: string           # Required: Path to base .scenario.yaml file
runs_per_combination: number    # Optional: Runs per combination (default: 1)
matrix: MatrixAxis[]           # Required: Array of parameter axes
```

### Matrix Axis Configuration

Each axis defines a parameter to vary and its possible values:

```yaml
matrix:
  - parameter: "character.llm.model"   # Parameter path using dot notation
    values:                            # Array of values to test
      - "gpt-4"
      - "claude-3-sonnet"
      - "llama-3-70b"
  
  - parameter: "run[0].input"          # Array index notation supported
    values:
      - "List GitHub issues"
      - "Show me open issues"
      - "What are the current problems?"
  
  - parameter: "setup.mocks[0].response.success"  # Nested object paths
    values:
      - true
      - false
```

### Parameter Path Syntax

Parameter paths support various formats:

| Format | Example | Description |
|--------|---------|-------------|
| Dot notation | `character.llm.model` | Access nested object properties |
| Array index | `run[0].input` | Access specific array elements |
| Mixed | `setup.mocks[0].response.data` | Combine objects and arrays |
| Deep nesting | `plugins[0].config.api.endpoint` | Multiple levels of nesting |

---

## Report Command

### `elizaos report generate`

Generate comprehensive reports from scenario matrix execution results.

#### Syntax
```bash
elizaos report generate <input_dir> [options]
```

#### Arguments
- **`<input_dir>`** _(required)_ - Directory containing run-*.json files from matrix execution

#### Options
- **`--output-path <path>`** - Path where report files will be saved
- **`--format <format>`** - Output format: "json", "html", "pdf", or "all" (default: "all")

#### Examples
```bash
# Generate all report formats in organized folder
elizaos report generate ./output/matrix-20231027-1000/

# Generate specific format to custom location
elizaos report generate ./results/ --format html --output-path ./reports/analysis.html

# Generate JSON report only
elizaos report generate ./data/ --format json --output-path ./summary.json
```

#### Output Structure

When using default behavior (no specific format), creates organized folder:
```
run-2024-01-15_10-30-45/
├── README.md          # Run summary
├── report.json        # Raw data and analysis
├── report.html        # Interactive web report
└── report.pdf         # Print-ready report
```

#### Report Data Structure

Generated reports contain:

```typescript
interface ReportData {
  metadata: {
    report_generated_at: string;
    matrix_config: MatrixConfig;
    input_directory: string;
    processed_files: number;
    skipped_files: number;
  };
  summary_stats: {
    total_runs: number;
    total_failed_runs: number;
    average_execution_time: number;
    median_execution_time: number;
    average_llm_calls: number;
    average_total_tokens: number;
    capability_success_rates: Record<string, number>;
    overall_success_rate: number;
  };
  results_by_parameter: Record<string, Record<string, ReportSummaryStats>>;
  common_trajectories: CommonTrajectory[];
  raw_results: ScenarioRunResult[];
}
```

---

## Examples

### Basic Scenario Example

```yaml
# basic-test.scenario.yaml
name: "Basic Agent Test"
description: "Tests basic agent interaction and file operations"

plugins:
  - "@elizaos/plugin-bootstrap"
  - name: "@elizaos/plugin-filesystem" 
    enabled: true

environment:
  type: local

setup:
  virtual_fs:
    "input.txt": "Hello World"

run:
  - name: "File Reading Test"
    input: "Please read the input.txt file and summarize its contents"
    evaluations:
      - type: "string_contains"
        value: "Hello World"
      - type: "llm_judge"
        prompt: "Did the agent successfully read and process the file?"
        expected: "yes"

judgment:
  strategy: all_pass
```

### Advanced LLM Judge Example

```yaml
# llm-evaluation.scenario.yaml
name: "Advanced LLM Evaluation Demo"
description: "Demonstrates various LLM judge configurations"

plugins:
  - "@elizaos/plugin-bootstrap"
  - "@elizaos/plugin-openai"

environment:
  type: e2b

run:
  - input: "Write a Python function to calculate fibonacci numbers"
    evaluations:
      # Simple yes/no judgment
      - type: "llm_judge"
        prompt: "Is this a correct fibonacci implementation?"
        expected: "yes"
        
      # Confidence scoring
      - type: "llm_judge"
        prompt: "Rate the code quality on a scale of 0-1"
        expected: "0.8+"
        temperature: 0.1
        
      # Structured output with JSON schema
      - type: "llm_judge"
        prompt: "Evaluate the code comprehensively"
        expected: "yes"
        json_schema:
          type: "object"
          properties:
            correctness: { type: "boolean" }
            efficiency: { type: "number", minimum: 0, maximum: 1 }
            readability: { type: "number", minimum: 0, maximum: 1 }
            feedback: { type: "string" }
          required: ["correctness", "efficiency", "readability", "feedback"]
          
      # Custom capabilities checklist
      - type: "llm_judge"
        prompt: "Assess the implementation against these criteria"
        expected: "yes"
        capabilities:
          - "Implements correct fibonacci algorithm"
          - "Handles edge cases (0, 1)"
          - "Uses efficient approach (not naive recursion)"
          - "Includes proper documentation"
          - "Follows Python naming conventions"

judgment:
  strategy: all_pass
```

### Complex Matrix Example

```yaml
# performance-matrix.matrix.yaml
name: "LLM Performance Analysis"
description: "Tests agent performance across different LLM configurations"
base_scenario: "code-generation.scenario.yaml"
runs_per_combination: 3

matrix:
  # Model variations
  - parameter: "character.llm.model"
    values:
      - "gpt-4"
      - "gpt-4-turbo"
      - "claude-3-sonnet"
      - "claude-3-haiku"
  
  # Temperature variations
  - parameter: "character.llm.temperature"
    values: [0.0, 0.3, 0.7, 1.0]
  
  # Task complexity variations
  - parameter: "run[0].input"
    values:
      - "Write a simple hello world function"
      - "Implement a binary search algorithm"
      - "Create a REST API with authentication"
  
  # Evaluation strictness
  - parameter: "run[0].evaluations[0].temperature"
    values: [0.0, 0.5]
```

### Mock Configuration Examples

```yaml
# Advanced mocking scenarios
setup:
  mocks:
    # GitHub API mocking
    - service: "github"
      method: "listIssues"
      when:
        input:
          owner: "elizaos"
          repo: "eliza"
      response:
        issues:
          - id: 1
            title: "Feature Request: Add new plugin"
            state: "open"
          - id: 2
            title: "Bug: Memory leak in core"
            state: "open"
      metadata:
        delay: 500  # Simulate network latency
    
    # Database operation mocking
    - service: "database"
      method: "query"
      when:
        partialArgs: ["SELECT"]
      responseFn: |
        function(args) {
          const query = args[0];
          if (query.includes('users')) {
            return { rows: [{ id: 1, name: 'test' }] };
          }
          return { rows: [] };
        }
    
    # Error simulation
    - service: "payment"
      method: "processPayment"
      error:
        code: "PAYMENT_FAILED"
        message: "Insufficient funds"
        status: 402
      metadata:
        probability: 0.2  # 20% chance of failure
```

---

## Best Practices

### Scenario Design

1. **Use Descriptive Names**: Make scenario and step names clear and descriptive
2. **Modular Evaluations**: Break complex evaluations into smaller, focused checks
3. **Environment Isolation**: Use `setup.virtual_fs` for test data instead of real files
4. **Mock External Dependencies**: Always mock external APIs and services for reliable testing

### Matrix Configuration

1. **Start Small**: Begin with simple matrices and gradually increase complexity
2. **Parameter Naming**: Use clear, hierarchical parameter paths
3. **Reasonable Combinations**: Consider the exponential growth of combinations
4. **Meaningful Variations**: Only vary parameters that meaningfully affect the outcome

### Performance Optimization

1. **Parallel Execution**: Use `--parallel` for faster matrix execution
2. **Filtering**: Use `--filter` to test specific parameter combinations during development
3. **Dry Runs**: Always use `--dry-run` first to validate matrix configuration
4. **Resource Monitoring**: Monitor system resources during large matrix runs

### Evaluation Strategy

1. **Multiple Evaluation Types**: Combine different evaluators for comprehensive testing
2. **LLM Judge Configuration**: Use appropriate temperature and model settings for consistent judging
3. **Custom Capabilities**: Define specific capabilities for domain-specific tasks
4. **Balanced Judgment**: Choose appropriate `all_pass` vs `any_pass` strategies

### Report Analysis

1. **Regular Reports**: Generate reports after every significant matrix run
2. **Parameter Comparison**: Focus on `results_by_parameter` to identify performance patterns
3. **Trajectory Analysis**: Use trajectory data to understand agent reasoning patterns
4. **Trend Monitoring**: Compare reports over time to track performance changes

This specification provides a complete reference for using ElizaOS scenario and report commands. For additional examples and use cases, refer to the examples in `packages/cli/src/commands/scenario/examples/`.
