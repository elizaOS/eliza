# Scenario Matrix Testing Guide

This document explains how to use scenario matrix testing to systematically evaluate ElizaOS agents across multiple parameter combinations.

## 🎉 Matrix Testing is Now Available!

The `elizaos scenario matrix` command is fully implemented and ready to use! You can now:

- ✅ Create and validate matrix configurations
- ✅ Analyze parameter combinations
- ✅ Filter and inspect test matrices
- ✅ Prepare for systematic agent testing

**Quick Start:**

**Production Command:**

```bash
# Try it now with the included example
elizaos scenario matrix packages/cli/src/commands/scenario/examples/github-issue-analysis.matrix.yaml --dry-run
```

**Local Development Command:**

```bash
# For local development
bun packages/cli/dist/index.js scenario matrix packages/cli/src/commands/scenario/examples/github-issue-analysis.matrix.yaml --dry-run
```

## Overview

Scenario matrix testing allows you to run the same base scenario with different parameter combinations to:

- Test agent behavior across different LLM models and configurations
- Evaluate performance and consistency under various conditions
- Perform systematic A/B testing for agent optimizations
- Validate plugin compatibility across different configurations
- Conduct regression testing with statistical confidence

Instead of running individual scenarios manually, matrix testing automatically generates and executes all parameter combinations, providing comprehensive comparative analysis.

## Matrix Configuration File Structure

A matrix configuration file (`.matrix.yaml`) defines:

1. **Base Scenario**: The template scenario to run with different parameters
2. **Parameter Matrix**: The axes of variation and their possible values
3. **Execution Settings**: How many times to run each combination
4. **Metadata**: Name and description for the test suite

### Basic Structure

```yaml
name: 'Test Matrix Name'
description: 'Optional description of what this matrix tests'
base_scenario: 'path/to/base.scenario.yaml'
runs_per_combination: 1 # Optional, defaults to 1
matrix:
  - parameter: 'parameter.path'
    values: [value1, value2, value3]
  - parameter: 'another.parameter'
    values: [valueA, valueB]
```

## Configuration Fields

### Required Fields

#### `name` (string)

A human-readable name for the test matrix.

```yaml
name: 'GitHub Issue Prompt Robustness'
```

#### `base_scenario` (string)

The file path (relative to the project root) to the base `.scenario.yaml` file that will be used as a template for each test run.

```yaml
base_scenario: 'packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml'
```

#### `matrix` (array)

An array of parameter axes, each defining what parameter to vary and what values to test.

```yaml
matrix:
  - parameter: 'character.llm.model'
    values: ['gpt-4-turbo', 'gpt-3.5-turbo']
  - parameter: 'character.temperature'
    values: [0.1, 0.5, 0.9]
```

### Optional Fields

#### `description` (string)

A longer description explaining the purpose and goals of the test matrix.

```yaml
description: 'Tests the reliability of listing GitHub issues under various LLM and prompt configurations.'
```

#### `runs_per_combination` (integer)

The number of times to execute each unique parameter combination. Use this to test for consistency and reduce variance in results. Defaults to `1`.

```yaml
runs_per_combination: 3 # Run each combination 3 times
```

## Parameter Specification

### Parameter Paths

Parameters are specified using dot notation to reference fields in the base scenario. The system supports:

- **Simple fields**: `character.name`
- **Nested objects**: `character.llm.model`
- **Array elements**: `run[0].input`
- **Deep nesting**: `setup.mocks[0].response.success`

### Parameter Values

Values can be of any type:

- **Strings**: `"gpt-4-turbo"`
- **Numbers**: `0.5`, `1000`
- **Booleans**: `true`, `false`
- **Objects**: `{ "key": "value" }`
- **Arrays**: `["item1", "item2"]`
- **Null**: `null`

### Matrix Axis Definition

Each axis in the matrix array must contain:

```yaml
- parameter: 'path.to.parameter' # Required: dot-notation path
  values: [value1, value2, ...] # Required: array of values to test
```

## Complete Examples

### Example 1: LLM Model Comparison

```yaml
name: 'GitHub Issue Action Chaining Analysis'
description: 'Tests the reliability of listing GitHub issues under various LLM and prompt configurations.'
base_scenario: 'packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml'
runs_per_combination: 3
matrix:
  - parameter: 'character.llm.model'
    values:
      - 'gpt-4-turbo'
      - 'gpt-3.5-turbo'
  - parameter: 'run[0].input'
    values:
      - 'List open issues for elizaOS/eliza'
      - 'Find current issues for the elizaos/eliza repo'
      - "Show me what's open in the elizaOS/eliza GitHub."
```

This configuration will generate **6 combinations** (2 models × 3 prompts) and run each **3 times** for a total of **18 test runs**.

### Example 2: Performance Testing

```yaml
name: 'Performance Matrix Test'
description: 'Test agent performance across different configurations'
base_scenario: 'performance-test.scenario.yaml'
runs_per_combination: 5
matrix:
  - parameter: 'character.llm.model'
    values: ['gpt-4', 'gpt-3.5-turbo', 'claude-3']
  - parameter: 'character.temperature'
    values: [0.1, 0.5, 0.9]
  - parameter: 'character.max_tokens'
    values: [1000, 2000, 4000]
```

This generates **27 combinations** (3×3×3) with **5 runs each** = **135 total test runs**.

### Example 3: Plugin Compatibility Testing

```yaml
name: 'Plugin Compatibility Matrix'
description: 'Test different plugin configurations across environments'
base_scenario: 'plugin-test.scenario.yaml'
runs_per_combination: 2
matrix:
  - parameter: 'plugins[0].name'
    values:
      - '@elizaos/plugin-bootstrap'
      - '@elizaos/plugin-sql'
      - '@elizaos/plugin-e2b'
  - parameter: 'plugins[0].enabled'
    values: [true, false]
  - parameter: 'environment.type'
    values: ['local', 'e2b']
```

### Example 4: Mock Configuration Testing

```yaml
name: 'Service Mock Behavior Analysis'
description: 'Test agent behavior with different mock configurations'
base_scenario: 'mock-test.scenario.yaml'
matrix:
  - parameter: 'setup.mocks[0].response.success'
    values: [true, false]
  - parameter: 'setup.mocks[0].metadata.delay'
    values: [0, 1000, 5000] # Test different response delays
  - parameter: 'character.temperature'
    values: [0.1, 0.9]
```

## Parameter Path Examples

Here are common parameter paths you might use:

### Character Configuration

```yaml
- parameter: 'character.llm.model'
  values: ['gpt-4', 'claude-3']
- parameter: 'character.temperature'
  values: [0.1, 0.5, 0.9]
- parameter: 'character.max_tokens'
  values: [1000, 4000]
```

### Scenario Run Steps

```yaml
- parameter: 'run[0].input'
  values: ['prompt 1', 'prompt 2']
- parameter: 'run[1].input'
  values: ['follow-up prompt A', 'follow-up prompt B']
```

### Environment Configuration

```yaml
- parameter: 'environment.type'
  values: ['local', 'e2b']
```

### Plugin Configuration

```yaml
- parameter: 'plugins[0].name'
  values: ['@elizaos/plugin-bootstrap', '@elizaos/plugin-sql']
- parameter: 'plugins[0].enabled'
  values: [true, false]
- parameter: 'plugins[0].config.apiKey'
  values: ['test-key-1', 'test-key-2']
```

### Mock Setup

```yaml
- parameter: 'setup.mocks[0].response.success'
  values: [true, false]
- parameter: 'setup.mocks[0].metadata.delay'
  values: [0, 1000, 2000]
- parameter: 'setup.mocks[1].response.data.count'
  values: [1, 10, 100]
```

## Best Practices

### 1. Start Small

Begin with a small number of parameters and values to understand the system before creating large matrices.

```yaml
# Good: Start with 2×2 = 4 combinations
matrix:
  - parameter: 'character.llm.model'
    values: ['gpt-4', 'gpt-3.5-turbo']
  - parameter: 'character.temperature'
    values: [0.1, 0.9]
```

### 2. Use Meaningful Names

Choose descriptive names that explain what you're testing.

```yaml
name: 'Trading Decision Consistency Across Models'
description: 'Evaluate whether different LLMs make consistent trading decisions given the same market data'
```

### 3. Consider Execution Time

Large matrices can take significant time to execute. Calculate total runs before starting:

- **Combinations**: product of all axis lengths
- **Total Runs**: combinations × runs_per_combination

```yaml
# This creates 3×4×2 = 24 combinations
# With runs_per_combination: 5 = 120 total runs
runs_per_combination: 5
matrix:
  - parameter: 'character.llm.model'
    values: ['gpt-4', 'gpt-3.5-turbo', 'claude-3'] # 3 values
  - parameter: 'character.temperature'
    values: [0.1, 0.3, 0.7, 0.9] # 4 values
  - parameter: 'environment.type'
    values: ['local', 'e2b'] # 2 values
```

### 4. Use Consistent Base Scenarios

Ensure your base scenario is well-designed and stable before creating matrices around it.

### 5. Group Related Parameters

Organize matrix axes logically. Group model-related parameters together, environment parameters together, etc.

### 6. Test Parameter Path Validity

Verify that your parameter paths actually exist in the base scenario and will be applied correctly.

## Common Parameter Patterns

### Model Comparison Pattern

```yaml
matrix:
  - parameter: 'character.llm.model'
    values: ['gpt-4', 'gpt-3.5-turbo', 'claude-3', 'llama-2']
  - parameter: 'character.temperature'
    values: [0.1, 0.5, 0.9]
```

### Prompt Engineering Pattern

```yaml
matrix:
  - parameter: 'run[0].input'
    values:
      - 'Direct command: List the issues'
      - 'Polite request: Could you please list the issues?'
      - 'Context-rich: As a developer, I need to see all open issues'
  - parameter: 'character.system_prompt'
    values:
      - 'You are a helpful assistant'
      - 'You are an expert developer assistant'
```

### Environment Testing Pattern

```yaml
matrix:
  - parameter: 'environment.type'
    values: ['local', 'e2b']
  - parameter: 'plugins'
    values:
      - ['@elizaos/plugin-bootstrap']
      - ['@elizaos/plugin-bootstrap', '@elizaos/plugin-sql']
```

### A/B Testing Pattern

```yaml
matrix:
  - parameter: 'character.llm.model'
    values: ['current-model', 'new-model']
  - parameter: 'run[0].input'
    values: ['test-prompt-v1', 'test-prompt-v2']
```

## Validation and Error Handling

The matrix configuration system provides comprehensive validation:

### Required Field Validation

Missing required fields will produce clear error messages:

```
Validation Error: "name" is required
Validation Error: "base_scenario" is required
Validation Error: "matrix" is required
```

### Type Validation

Incorrect field types are clearly identified:

```
Validation Error: "runs_per_combination" must be a number
Validation Error: "matrix" must be an array
```

### Constraint Validation

Business rule violations are caught:

```
Validation Error: "matrix" must contain at least 1 axis
Validation Error: "values" array must contain at least 1 element
Validation Error: "runs_per_combination" must be greater than or equal to 1
```

## Integration with Existing Scenarios

Matrix testing builds on the existing scenario system. Any valid `.scenario.yaml` file can be used as a base scenario for matrix testing.

### Base Scenario Requirements

- Must be a valid scenario file that passes normal scenario validation
- Should be stable and well-tested individually before using in matrices
- Parameter paths in the matrix must correspond to actual fields in the scenario

### Parameter Override Behavior

- Matrix parameters override corresponding fields in the base scenario
- Original base scenario values are used for any fields not specified in the matrix
- Parameter overrides are applied before scenario execution
- Each test run gets a completely isolated copy of the scenario with overrides applied

## File Organization

Recommended file structure:

```
project/
├── scenarios/
│   ├── base/
│   │   ├── github-issues.scenario.yaml
│   │   ├── trading-analysis.scenario.yaml
│   │   └── plugin-test.scenario.yaml
│   └── matrices/
│       ├── github-robustness.matrix.yaml
│       ├── trading-models.matrix.yaml
│       └── plugin-compatibility.matrix.yaml
```

## Troubleshooting

### Common Issues

1. **Invalid Parameter Path**: Ensure the parameter path exists in your base scenario
2. **Empty Values Array**: Each matrix axis must have at least one value
3. **Missing Base Scenario**: Verify the base_scenario path is correct and the file exists
4. **Large Matrix Warning**: Be cautious with matrices that generate hundreds of combinations

### Debugging Tips

1. Start with `runs_per_combination: 1` during development
2. Test your base scenario individually first
3. Validate parameter paths by manually checking the base scenario structure
4. Use descriptive names and descriptions to track what you're testing

## Using the Matrix CLI Command

The `elizaos scenario matrix` command is now available and provides comprehensive matrix testing capabilities.

### Basic Usage

**Production Commands:**

```bash
# Run matrix analysis and show execution plan
elizaos scenario matrix path/to/config.matrix.yaml

# Dry run mode - analysis only, no execution
elizaos scenario matrix path/to/config.matrix.yaml --dry-run

# Verbose mode - show detailed information
elizaos scenario matrix path/to/config.matrix.yaml --verbose

# Filter combinations by pattern
elizaos scenario matrix path/to/config.matrix.yaml --filter "gpt-4"

# Specify parallel execution (for future implementation)
elizaos scenario matrix path/to/config.matrix.yaml --parallel 4
```

**Local Development Commands:**

```bash
# Run matrix analysis and show execution plan
bun packages/cli/dist/index.js scenario matrix path/to/config.matrix.yaml

# Dry run mode - analysis only, no execution
bun packages/cli/dist/index.js scenario matrix path/to/config.matrix.yaml --dry-run

# Verbose mode - show detailed information
bun packages/cli/dist/index.js scenario matrix path/to/config.matrix.yaml --verbose

# Filter combinations by pattern
bun packages/cli/dist/index.js scenario matrix path/to/config.matrix.yaml --filter "gpt-4"

# Specify parallel execution (for future implementation)
bun packages/cli/dist/index.js scenario matrix path/to/config.matrix.yaml --parallel 4
```

### Command Options

- **`--dry-run`**: Show matrix analysis without executing tests (default: false)
- **`--parallel <number>`**: Maximum number of parallel test runs (default: "1")
- **`--filter <pattern>`**: Filter parameter combinations by pattern
- **`--verbose`**: Show detailed progress information (default: false)
- **`-h, --help`**: Display help for the command

### Example Command Output

When you run `elizaos scenario matrix config.matrix.yaml --dry-run`, you'll see:

```
🧪 Starting matrix analysis with config: config.matrix.yaml
📂 Loading matrix configuration from: /path/to/config.matrix.yaml
🔍 Validating matrix configuration...
✅ Matrix configuration is valid!

📊 Matrix Analysis:
   Name: GitHub Issue Action Chaining Analysis
   Description: Tests the reliability of listing GitHub issues...
   Base Scenario: packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml
   Runs per combination: 3
   Matrix axes: 2
   Total combinations: 6
   Total test runs: 18

🎯 Matrix Structure:
   Axis 1: character.llm.model
     Values: ["gpt-4-turbo", "gpt-3.5-turbo"]
     Count: 2
   Axis 2: run[0].input
     Values: ["List open issues for elizaOS/eliza", "Find current issues...", "Show me what's open..."]
     Count: 3

✅ Base scenario file found: /path/to/base-scenario.yaml

🔀 Parameter Combinations:
   1. {"character.llm.model":"gpt-4-turbo","run[0].input":"List open issues for elizaOS/eliza"}
   2. {"character.llm.model":"gpt-4-turbo","run[0].input":"Find current issues for the elizaos/eliza repo"}
   3. {"character.llm.model":"gpt-4-turbo","run[0].input":"Show me what's open in the elizaOS/eliza GitHub."}
   4. {"character.llm.model":"gpt-3.5-turbo","run[0].input":"List open issues for elizaOS/eliza"}
   5. {"character.llm.model":"gpt-3.5-turbo","run[0].input":"Find current issues for the elizaos/eliza repo"}
   6. {"character.llm.model":"gpt-3.5-turbo","run[0].input":"Show me what's open in the elizaOS/eliza GitHub."}

🔍 Dry Run Complete - Matrix Analysis Only
✨ Matrix configuration is valid and ready for execution.
📝 To execute the matrix, run the same command without --dry-run
```

### Error Handling

The command provides clear, actionable error messages:

#### Missing File

```
❌ Error: Matrix configuration file not found at '/path/to/missing.matrix.yaml'
💡 Make sure the file exists and the path is correct.
```

#### Invalid YAML Syntax

```
❌ Error: Failed to parse YAML configuration file:
YAMLException: bad indentation of a mapping entry at line 5, column 3
💡 Check that your YAML syntax is valid.
```

#### Schema Validation Errors

```
❌ Matrix configuration validation failed:
   name: Required
   base_scenario: Required
   runs_per_combination: Runs per combination must be greater than or equal to 1
   matrix: Required
💡 Please fix the configuration errors and try again.
📖 See the matrix testing documentation for examples and guidance.
```

#### Missing Base Scenario

```
❌ Error: Base scenario file not found at '/path/to/base.scenario.yaml'
💡 Make sure the base_scenario path in your matrix config is correct.
```

### Implementation Status

✅ **Available Now (Tickets #5778, #5779):**

- Matrix configuration schema and validation
- `elizaos scenario matrix` CLI command
- Complete analysis and reporting
- Parameter combination generation
- Filtering and dry-run capabilities
- Comprehensive error handling

🚧 **Coming Soon:**

- **Parameter Override System** (Ticket #5780): Runtime parameter injection into base scenarios
- **Matrix Execution** (Epic #5781): Actual test execution, parallel processing, and comprehensive reporting

### Getting Help

**Production Commands:**

```bash
# Show help for the matrix command
elizaos scenario matrix --help

# Show help for all scenario commands
elizaos scenario --help
```

**Local Development Commands:**

```bash
# Show help for the matrix command
bun packages/cli/dist/index.js scenario matrix --help

# Show help for all scenario commands
bun packages/cli/dist/index.js scenario --help
```

This matrix testing system enables systematic, scientific evaluation of ElizaOS agents across multiple dimensions, providing the data needed to optimize agent performance and reliability.
