# Scenario and Matrix File Format Specification

This document provides a simple specification for creating `scenario.yaml` and `matrix.yaml` files for ElizaOS testing.

## scenario.yaml Format

A scenario file defines a test case with specific steps, evaluations, and expected outcomes.

### Basic Structure

```yaml
name: 'Your Scenario Name'
description: 'Description of what this scenario tests'

plugins:
  - name: '@elizaos/plugin-bootstrap'
    enabled: true
  - name: '@elizaos/plugin-openai'
    enabled: true

# Optional: Character configuration
character:
  name: 'agent-name'
  bio: 'Agent description'
  llm:
    model: 'gpt-4-turbo'
  temperature: 0.7

environment:
  type: local # or "e2b"

# Optional: Setup configuration
setup:
  mocks:
    - service: 'ServiceName'
      method: 'methodName'
      response:
        success: true
        data: { 'key': 'value' }
  virtual_fs:
    '/path/to/file.txt': 'file content'

run:
  - name: 'Test Step Name'
    input: 'Message or prompt to send to the agent'

    # Optional: For multi-turn conversations
    conversation:
      max_turns: 5
      timeout_per_turn_ms: 30000

      user_simulator:
        persona: 'Description of user persona'
        objective: 'What the user is trying to achieve'
        temperature: 0.7
        style: 'Communication style'
        constraints:
          - 'Constraint 1'
          - 'Constraint 2'

      termination_conditions:
        - type: 'user_expresses_satisfaction'
          keywords: ['thank you', 'resolved', 'great']
        - type: 'agent_provides_solution'
          keywords: ['solution', 'resolved', 'complete']

      turn_evaluations:
        - type: 'llm_judge'
          prompt: 'Evaluation question for each turn'
          expected: 'yes'

      final_evaluations:
        - type: 'llm_judge'
          prompt: 'Final evaluation question'
          expected: 'yes'
          capabilities:
            - 'Capability 1 to evaluate'
            - 'Capability 2 to evaluate'

    # Standard evaluations (always present)
    evaluations:
      - type: 'string_contains'
        value: 'expected text'
      - type: 'llm_judge'
        prompt: 'Evaluation question'
        expected: 'yes'
      - type: 'trajectory_contains_action'
        action: ACTION_NAME
        description: 'Description of expected action'

judgment:
  strategy: all_pass
```

### Required Fields

- `name`: Unique identifier for the scenario
- `description`: Human-readable description
- `environment.type`: Usually "local" or "e2b"
- `run`: Array of test steps
- `judgment.strategy`: How to determine pass/fail

### Optional Fields

- `plugins`: Array of required plugins (usually recommended)
- `character`: Agent character configuration
- `setup`: Environment setup including mocks and virtual filesystem
- `conversation`: For multi-turn conversations with simulated user
- `evaluations`: Various evaluation types per step

## matrix.yaml Format

A matrix file defines parameter variations to run against a base scenario multiple times.

### Basic Structure

```yaml
name: 'Matrix Test Name'
description: 'Description of what variations this matrix tests'

base_scenario: 'path/to/base-scenario.scenario.yaml'
runs_per_combination: 2

matrix:
  # Simple parameter variation
  - parameter: 'name'
    values:
      - 'Value A'
      - 'Value B'

  # Nested parameter variation (using dot notation)
  - parameter: 'run[0].conversation.max_turns'
    values: [3, 5, 8]

  # Deep nested parameter
  - parameter: 'run[0].conversation.user_simulator.persona'
    values:
      - 'frustrated customer'
      - 'curious beginner'
      - 'experienced user'

  # Numeric values
  - parameter: 'run[0].conversation.user_simulator.temperature'
    values: [0.3, 0.7, 0.9]
```

### Required Fields

- `name`: Matrix identifier
- `description`: What the matrix tests
- `base_scenario`: Path to the base scenario file
- `matrix`: Array of parameter variations

### Optional Fields

- `runs_per_combination`: Number of runs per combination (default: 1)

## Evaluation Types

### Common Evaluation Types

1. **string_contains**

   ```yaml
   - type: 'string_contains'
     value: 'expected text in response'
   ```

2. **llm_judge**

   ```yaml
   - type: 'llm_judge'
     prompt: 'Question to evaluate the response'
     expected: 'yes'
     capabilities: # Optional
       - 'Specific capability to check'
   ```

3. **trajectory_contains_action**

   ```yaml
   - type: 'trajectory_contains_action'
     action: ACTION_NAME
     description: 'Description of expected action'
   ```

4. **execution_time**

   ```yaml
   - type: 'execution_time'
     max_duration_ms: 10000
     min_duration_ms: 100 # Optional
     target_duration_ms: 500 # Optional
   ```

5. **regex_match**

   ```yaml
   - type: 'regex_match'
     pattern: "\\d{4}-\\d{2}-\\d{2}" # Date pattern example
   ```

6. **file_exists**

   ```yaml
   - type: 'file_exists'
     path: '/path/to/expected/file.txt'
   ```

7. **file_contains**

   ```yaml
   - type: 'file_contains'
     path: '/path/to/file.txt'
     value: 'expected content'
   ```

8. **command_exit_code_is**
   ```yaml
   - type: 'command_exit_code_is'
     command: 'ls /tmp'
     expected_code: 0
   ```

### Conversation-Specific Evaluations

9. **conversation_length**

   ```yaml
   - type: 'conversation_length'
     min_turns: 3
     max_turns: 10
     optimal_turns: 6
   ```

10. **conversation_flow**

    ```yaml
    - type: 'conversation_flow'
      required_patterns: ['question_then_answer', 'clarification_cycle']
      flow_quality_threshold: 0.8
    ```

11. **user_satisfaction**

    ```yaml
    - type: 'user_satisfaction'
      satisfaction_threshold: 0.8
      measurement_method: 'llm_judge'
    ```

12. **context_retention**
    ```yaml
    - type: 'context_retention'
      test_memory_of: ['concept1', 'concept2']
      retention_turns: 5
      memory_accuracy_threshold: 0.85
    ```

## User Simulator Configuration

For multi-turn conversations, configure the user simulator:

```yaml
user_simulator:
  model_type: 'TEXT_LARGE' # Optional
  temperature: 0.7 # Creativity level (0.0-1.0)
  max_tokens: 250 # Response length limit
  persona: 'User character description'
  objective: 'What user wants to achieve'
  style: 'Communication style'
  constraints:
    - 'Behavioral constraint 1'
    - 'Behavioral constraint 2'
  emotional_state: 'Current mood' # Optional
  knowledge_level: 'beginner' # Optional
```

## Termination Conditions

Define when conversations should end:

```yaml
termination_conditions:
  - type: 'user_expresses_satisfaction'
    keywords: ['thank you', 'solved', 'perfect']

  - type: 'agent_provides_solution'
    keywords: ["here's how", 'solution', 'steps']

  - type: 'escalation_needed'
    keywords: ['speak to manager', 'escalate']

  - type: 'custom_condition'
    llm_judge:
      prompt: 'Has the objective been met?'
      threshold: 0.8
```

## Judgment Strategies

- `all_pass`: All evaluations must pass (most common)
- `any_pass`: At least one evaluation must pass
- `majority_pass`: Most evaluations must pass
- `weighted`: Weighted scoring (requires weights configuration)

## Advanced Matrix Parameter Paths

### Character Configuration Parameters

```yaml
- parameter: 'character.llm.model'
  values: ['gpt-4-turbo', 'gpt-3.5-turbo', 'claude-3']
- parameter: 'character.temperature'
  values: [0.1, 0.5, 0.9]
- parameter: 'character.name'
  values: ['agent-v1', 'agent-v2']
```

### Environment and Setup Parameters

```yaml
- parameter: 'environment.type'
  values: ['local', 'e2b']
- parameter: 'setup.mocks[0].response.success'
  values: [true, false]
- parameter: 'setup.mocks[0].metadata.delay'
  values: [0, 1000, 5000]
```

### Plugin Configuration Parameters

```yaml
- parameter: 'plugins[0].enabled'
  values: [true, false]
- parameter: 'plugins[1].name'
  values: ['@elizaos/plugin-github', '@elizaos/plugin-sql']
```

### Run Step Parameters

```yaml
- parameter: 'run[0].input'
  values: ['prompt variation 1', 'prompt variation 2']
- parameter: 'run[0].conversation.max_turns'
  values: [3, 5, 10]
- parameter: 'run[0].evaluations[0].value'
  values: ['expected1', 'expected2']
```

## Example File Names

- `basic-test.scenario.yaml`
- `advanced-conversation.scenario.yaml`
- `parameter-sweep.matrix.yaml`
- `conversation-variations.matrix.yaml`
- `llm-model-comparison.matrix.yaml`
- `plugin-compatibility.matrix.yaml`

## Additional Configuration Options

### Mock Service Configuration

```yaml
setup:
  mocks:
    - service: 'github-service'
      method: 'listIssues'
      when:
        input:
          owner: 'elizaOS'
          repo: 'eliza'
      response:
        issues:
          - title: 'Fix bug in scenario runner'
            number: 123
            state: 'open'
      metadata:
        delay: 1000 # Simulate network delay
        probability: 0.9 # 90% success rate
    - service: 'file-service'
      method: 'readFile'
      error:
        code: 'FILE_NOT_FOUND'
        message: 'File does not exist'
```

### Environment-Specific Setup

```yaml
environment:
  type: e2b
  setup:
    workingDirectory: "/tmp/test"
    timeout: 300000

# OR for local environment
environment:
  type: local
  setup:
    cleanup: true
    isolate: true
```

### Plugin Configuration Variations

```yaml
plugins:
  # Simple string reference
  - '@elizaos/plugin-bootstrap'

  # Full configuration object
  - name: '@elizaos/plugin-github'
    enabled: true
    version: '1.0.0'
    config:
      apiKey: 'test-key'
      rateLimitDelay: 1000
```

## CLI Commands and Options

### Scenario Execution

```bash
# Production commands
elizaos scenario run <scenario-file> [options]
elizaos scenario matrix <matrix-config> [options]

# Local development commands
bun packages/cli/dist/index.js scenario run <scenario-file> [options]
bun packages/cli/dist/index.js scenario matrix <matrix-config> [options]
```

### Scenario Run Options

- `--live` - Run in live mode, ignoring all mocks and using real services (default: false)

### Matrix Run Options

- `--dry-run` - Show matrix analysis without executing tests (default: false)
- `--parallel <number>` - Maximum number of parallel test runs (default: "1")
- `--filter <pattern>` - Filter parameter combinations by pattern matching
- `--verbose` - Show detailed progress information (default: false)

## Output Files and Logging

### Automatic File Generation

The scenario system automatically creates organized output files:

```
packages/cli/src/commands/scenario/_logs_/
├── run-001-step-0-execution.json      # Individual step execution results
├── run-001-step-0-evaluation.json     # Individual step evaluation results
├── run-001.json                       # Centralized scenario result
├── matrix-001/                        # Matrix execution results folder
│   ├── combination-1-run-1.json      # Individual matrix run results
│   └── summary.json                   # Matrix execution summary
└── run-2025-08-17_16-43-39/          # Generated report folder
    ├── README.md                      # Auto-generated summary
    ├── report.json                    # Raw data & analysis
    ├── report.html                    # Interactive web report
    └── report.pdf                     # Print-ready report
```

### Environment Variables

- `PGLITE_DATA_DIR` - Automatically set to isolated directory per scenario run
  - Format: `test-data/scenario-{timestamp}-{randomId}`
  - Ensures database isolation between runs

## Default Plugin Behavior

### Automatically Included Plugins

The system automatically includes these plugins if not specified:

- `@elizaos/plugin-sql` - Database operations
- `@elizaos/plugin-bootstrap` - Core functionality
- `@elizaos/plugin-openai` - LLM operations

### Plugin Format Options

```yaml
plugins:
  # Simple string format
  - '@elizaos/plugin-bootstrap'

  # Object format with configuration
  - name: '@elizaos/plugin-github'
    enabled: true
    version: '1.0.0'
    config:
      apiKey: 'your-api-key'
      rateLimitDelay: 1000

  # Object format with enabled/disabled control
  - name: '@elizaos/plugin-sql'
    enabled: false # Exclude this plugin from run
```

## Enhanced Evaluation System

### Evaluation Result Structure

The system uses enhanced evaluation results with structured output:

```json
{
  "evaluator_type": "string_contains",
  "success": true,
  "summary": "Text found in agent response",
  "details": {
    "search_term": "expected text",
    "found_at_position": 45,
    "context": "...surrounding text..."
  },
  "execution_time_ms": 150,
  "metadata": {
    "evaluator_version": "1.0.0"
  }
}
```

### Fallback Behavior

- Tries enhanced evaluations first (structured output)
- Falls back to legacy evaluations if enhanced format fails
- Maintains backward compatibility with existing scenarios

### Evaluation Requirements by Runtime

**With Runtime Available:**

- All evaluation types supported
- `llm_judge`, `trajectory_contains_action`, complex evaluators
- Enhanced structured output format
- Access to agent trajectory and memory

**Without Runtime (Basic Mode):**

- Limited to simple evaluators: `string_contains`, `regex_match`
- Legacy boolean output format
- No access to agent internals or LLM services

## Matrix Execution Features

### Resource Management

- Automatic process cleanup on shutdown/error
- Graceful handling of SIGINT/SIGTERM signals
- Resource monitoring with warnings for high CPU/memory usage
- Configurable timeouts and parallel execution limits

### Progress Tracking

Matrix execution provides real-time progress updates:

- Combination start/completion notifications
- Success rate tracking per combination
- Resource usage alerts and recommendations
- Execution time estimates (optimistic/realistic/pessimistic)

### Parameter Path Validation

Matrix configurations automatically validate parameter paths:

- Ensures all parameter paths exist in base scenario
- Supports deep nested paths with array indices
- Provides clear error messages for invalid paths

## Live vs Test Mode

### Test Mode (Default)

- Uses all configured mocks
- Runs in isolated environment
- Database seeded with test data
- Deterministic and repeatable results

### Live Mode (`--live` flag)

- Ignores all mock configurations
- Connects to real external services
- Uses production databases and APIs
- Suitable for integration testing and real workflows

## Error Handling and Recovery

### Automatic Error Recording

- All errors recorded in centralized data aggregator
- Failed runs generate error result files
- Process cleanup on unexpected failures
- Graceful degradation when services unavailable

### Mock System Cleanup

- Mocks automatically reverted after execution
- Clean state restoration even on failures
- No persistent changes to system state

## Schema Validation and Error Messages

### Scenario File Validation

The system performs comprehensive validation using Zod schemas:

```yaml
# This will fail validation:
name: 123 # Error: name must be string
environment: 'wrong' # Error: environment must be object
run: 'not-array' # Error: run must be array

# Error output includes:
# - Field path (e.g., "environment.type")
# - Expected vs actual type
# - Descriptive error messages
```

### Matrix Configuration Validation

Matrix files undergo multi-level validation:

1. **Structure Validation**: YAML syntax and schema compliance
2. **Base Scenario Validation**: Referenced scenario file must be valid
3. **Parameter Path Validation**: All parameter paths must exist in base scenario
4. **Value Type Validation**: Parameter values must match expected types

### Common Validation Errors

#### Scenario Files

```
❌ name: Required
❌ environment.type: Invalid enum value, expected "local" or "e2b"
❌ run: Required, must be array with at least 1 element
❌ judgment.strategy: Invalid enum value, expected "all_pass" or "any_pass"
```

#### Matrix Files

```
❌ base_scenario: Required
❌ matrix: Must contain at least 1 axis
❌ matrix[0].parameter: Required
❌ matrix[0].values: Must contain at least 1 element
❌ runs_per_combination: Must be greater than or equal to 1
```

#### Parameter Path Errors

```
❌ Parameter path "nonexistent.field" not found in base scenario
❌ Parameter path "run[99].input" array index out of bounds
❌ Parameter path "character.llm.invalid" object property does not exist
```

## Advanced Configuration Features

### Automatic Resource Management

- **Database Isolation**: Each run gets unique PGLite directory
- **Process Cleanup**: Automatic cleanup of child processes on exit
- **Signal Handling**: Graceful shutdown on CTRL+C (SIGINT) and SIGTERM
- **Memory Management**: Configurable limits and monitoring

### Plugin System Integration

```yaml
# Plugin validation includes:
# - Plugin availability check
# - Dependency resolution
# - Version compatibility
# - Configuration validation
```

### Trajectory and Data Collection

The system automatically tracks:

- **Agent Cognitive Process**: Step-by-step decision making
- **LLM Interactions**: Prompts, responses, and token usage
- **Action Execution**: Sequence and timing of agent actions
- **Performance Metrics**: Execution time, resource usage
- **Error Context**: Stack traces and failure points

## Best Practices

1. Use descriptive names and descriptions
2. Start with simple scenarios before adding complexity
3. Include both positive and negative test cases
4. Use appropriate evaluation types for your test goals
5. Set realistic timeout values for conversations
6. Test edge cases with matrix variations
7. Keep user simulator personas consistent and realistic
8. Always include required plugins (`@elizaos/plugin-bootstrap` is usually needed)
9. Use mocks for deterministic testing, live mode for integration testing
10. Test both success and failure scenarios
11. Use `--dry-run` for matrix validation before full execution
12. Monitor resource usage for large matrix tests
13. Use filtering to reduce matrix scope during development
14. Check output logs for detailed execution analysis
