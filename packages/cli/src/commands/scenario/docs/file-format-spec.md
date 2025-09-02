# Scenario and Matrix File Format Specification

This document provides a simple specification for creating `scenario.yaml` and `matrix.yaml` files for ElizaOS testing.

## scenario.yaml Format

A scenario file defines a test case with specific steps, evaluations, and expected outcomes.

### Basic Structure

```yaml
name: "Your Scenario Name"
description: "Description of what this scenario tests"

plugins:
  - name: '@elizaos/plugin-bootstrap'
    enabled: true
  - name: '@elizaos/plugin-openai'
    enabled: true

# Optional: Character configuration
character:
  name: "agent-name"
  bio: "Agent description"
  llm:
    model: "gpt-4-turbo"
  temperature: 0.7

environment:
  type: local  # or "e2b"

# Optional: Setup configuration
setup:
  mocks:
    - service: "ServiceName"
      method: "methodName"
      response:
        success: true
        data: { "key": "value" }
  virtual_fs:
    "/path/to/file.txt": "file content"

run:
  - name: "Test Step Name"
    input: "Message or prompt to send to the agent"
    
    # Optional: For multi-turn conversations
    conversation:
      max_turns: 5
      timeout_per_turn_ms: 30000
      
      user_simulator:
        persona: "Description of user persona"
        objective: "What the user is trying to achieve"
        temperature: 0.7
        style: "Communication style"
        constraints:
          - "Constraint 1"
          - "Constraint 2"
      
      termination_conditions:
        - type: "user_expresses_satisfaction"
          keywords: ["thank you", "resolved", "great"]
        - type: "agent_provides_solution"
          keywords: ["solution", "resolved", "complete"]
      
      turn_evaluations:
        - type: "llm_judge"
          prompt: "Evaluation question for each turn"
          expected: "yes"
      
      final_evaluations:
        - type: "llm_judge"
          prompt: "Final evaluation question"
          expected: "yes"
          capabilities:
            - "Capability 1 to evaluate"
            - "Capability 2 to evaluate"
    
    # Standard evaluations (always present)
    evaluations:
      - type: "string_contains"
        value: "expected text"
      - type: "llm_judge"
        prompt: "Evaluation question"
        expected: "yes"
      - type: "trajectory_contains_action"
        action: ACTION_NAME
        description: "Description of expected action"

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
name: "Matrix Test Name"
description: "Description of what variations this matrix tests"

base_scenario: "path/to/base-scenario.scenario.yaml"
runs_per_combination: 2

matrix:
  # Simple parameter variation
  - parameter: "name"
    values:
      - "Value A"
      - "Value B"
  
  # Nested parameter variation (using dot notation)
  - parameter: "run[0].conversation.max_turns"
    values: [3, 5, 8]
  
  # Deep nested parameter
  - parameter: "run[0].conversation.user_simulator.persona"
    values:
      - "frustrated customer"
      - "curious beginner"
      - "experienced user"
  
  # Numeric values
  - parameter: "run[0].conversation.user_simulator.temperature"
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
   - type: "string_contains"
     value: "expected text in response"
   ```

2. **llm_judge**
   ```yaml
   - type: "llm_judge"
     prompt: "Question to evaluate the response"
     expected: "yes"
     capabilities:  # Optional
       - "Specific capability to check"
   ```

3. **trajectory_contains_action**
   ```yaml
   - type: "trajectory_contains_action"
     action: ACTION_NAME
     description: "Description of expected action"
   ```

4. **execution_time**
   ```yaml
   - type: "execution_time"
     max_duration_ms: 10000
     min_duration_ms: 100        # Optional
     target_duration_ms: 500     # Optional
   ```

5. **regex_match**
   ```yaml
   - type: "regex_match"
     pattern: "\\d{4}-\\d{2}-\\d{2}"  # Date pattern example
   ```

6. **file_exists**
   ```yaml
   - type: "file_exists"
     path: "/path/to/expected/file.txt"
   ```

7. **file_contains**
   ```yaml
   - type: "file_contains"
     path: "/path/to/file.txt"
     value: "expected content"
   ```

8. **command_exit_code_is**
   ```yaml
   - type: "command_exit_code_is"
     command: "ls /tmp"
     expected_code: 0
   ```

### Conversation-Specific Evaluations

9. **conversation_length**
   ```yaml
   - type: "conversation_length"
     min_turns: 3
     max_turns: 10
     optimal_turns: 6
   ```

10. **conversation_flow**
    ```yaml
    - type: "conversation_flow"
      required_patterns: ["question_then_answer", "clarification_cycle"]
      flow_quality_threshold: 0.8
    ```

11. **user_satisfaction**
    ```yaml
    - type: "user_satisfaction"
      satisfaction_threshold: 0.8
      measurement_method: "llm_judge"
    ```

12. **context_retention**
    ```yaml
    - type: "context_retention"
      test_memory_of: ["concept1", "concept2"]
      retention_turns: 5
      memory_accuracy_threshold: 0.85
    ```

## User Simulator Configuration

For multi-turn conversations, configure the user simulator:

```yaml
user_simulator:
  model_type: "TEXT_LARGE"        # Optional
  temperature: 0.7                # Creativity level (0.0-1.0)
  max_tokens: 250                 # Response length limit
  persona: "User character description"
  objective: "What user wants to achieve"
  style: "Communication style"
  constraints:
    - "Behavioral constraint 1"
    - "Behavioral constraint 2"
  emotional_state: "Current mood"  # Optional
  knowledge_level: "beginner"     # Optional
```

## Termination Conditions

Define when conversations should end:

```yaml
termination_conditions:
  - type: "user_expresses_satisfaction"
    keywords: ["thank you", "solved", "perfect"]
  
  - type: "agent_provides_solution"
    keywords: ["here's how", "solution", "steps"]
  
  - type: "escalation_needed"
    keywords: ["speak to manager", "escalate"]
  
  - type: "custom_condition"
    llm_judge:
      prompt: "Has the objective been met?"
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
- parameter: "character.llm.model"
  values: ["gpt-4-turbo", "gpt-3.5-turbo", "claude-3"]
- parameter: "character.temperature" 
  values: [0.1, 0.5, 0.9]
- parameter: "character.name"
  values: ["agent-v1", "agent-v2"]
```

### Environment and Setup Parameters
```yaml
- parameter: "environment.type"
  values: ["local", "e2b"]
- parameter: "setup.mocks[0].response.success"
  values: [true, false]
- parameter: "setup.mocks[0].metadata.delay"
  values: [0, 1000, 5000]
```

### Plugin Configuration Parameters
```yaml
- parameter: "plugins[0].enabled"
  values: [true, false]
- parameter: "plugins[1].name"
  values: ["@elizaos/plugin-github", "@elizaos/plugin-sql"]
```

### Run Step Parameters
```yaml
- parameter: "run[0].input"
  values: ["prompt variation 1", "prompt variation 2"]
- parameter: "run[0].conversation.max_turns"
  values: [3, 5, 10]
- parameter: "run[0].evaluations[0].value"
  values: ["expected1", "expected2"]
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
    - service: "github-service"
      method: "listIssues"
      when:
        input:
          owner: "elizaOS"
          repo: "eliza"
      response:
        issues:
          - title: "Fix bug in scenario runner"
            number: 123
            state: "open"
      metadata:
        delay: 1000        # Simulate network delay
        probability: 0.9   # 90% success rate
    - service: "file-service"
      method: "readFile"
      error:
        code: "FILE_NOT_FOUND"
        message: "File does not exist"
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
  - "@elizaos/plugin-bootstrap"
  
  # Full configuration object
  - name: "@elizaos/plugin-github" 
    enabled: true
    version: "1.0.0"
    config:
      apiKey: "test-key"
      rateLimitDelay: 1000
```

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
