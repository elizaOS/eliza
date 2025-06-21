# Scenario Testing Framework

The Scenario Testing Framework provides comprehensive testing capabilities for ElizaOS agents through realistic, multi-actor scenarios. It enables automated testing of agent capabilities including reasoning, research, coding, planning, and social interactions.

## Overview

This framework allows you to:

- **Test Agent Capabilities**: Evaluate how agents perform in realistic scenarios
- **Multi-Actor Testing**: Create scenarios with multiple participants (human-like actors)
- **Benchmarking**: Measure performance, response times, and resource usage
- **Verification**: Use both LLM-based and rule-based verification of outcomes
- **Automation**: Run tests as part of CI/CD pipelines

## Architecture

### Core Components

1. **ScenarioRunner**: Orchestrates scenario execution
2. **ScenarioVerifier**: Validates outcomes using multiple verification methods
3. **MetricsCollector**: Tracks performance and usage metrics
4. **BenchmarkAnalyzer**: Provides performance analysis and comparisons

### Scenario Structure

Each scenario consists of:

- **Actors**: Participants in the scenario (subject agent + test actors)
- **Setup**: Environment configuration and initial context
- **Execution**: Script steps and interaction patterns
- **Verification**: Rules to validate expected outcomes
- **Benchmarks**: Performance targets and metrics

## Usage

### Running Scenarios

```bash
# Run all scenarios in the scenarios directory
elizaos scenario

# Run a specific scenario file
elizaos scenario --scenario ./scenarios/truth-vs-lie.ts

# Run scenarios from a directory with filtering
elizaos scenario --directory ./test-scenarios --filter "research"

# Run with benchmarking enabled
elizaos scenario --benchmark --output results.json

# Run scenarios in parallel
elizaos scenario --parallel --max-concurrency 3
```

### Command Options

- `--scenario <path>`: Run a specific scenario file
- `--directory <path>`: Run all scenarios from a directory
- `--filter <pattern>`: Filter scenarios by name or tags
- `--benchmark`: Enable detailed performance metrics
- `--verbose`: Show detailed output
- `--output <file>`: Save results to file
- `--format <type>`: Output format (json|text|html)
- `--parallel`: Run scenarios concurrently
- `--max-concurrency <num>`: Maximum concurrent scenarios

## Creating Scenarios

### Basic Structure

```typescript
import type { Scenario } from '@elizaos/cli/scenario-runner';

export const myScenario: Scenario = {
  id: 'my-test-scenario',
  name: 'My Test Scenario',
  description: 'Tests agent capability X',
  category: 'reasoning',
  tags: ['logic', 'problem-solving'],

  actors: [
    {
      id: 'subject',
      name: 'Test Agent',
      role: 'subject', // The agent being tested
    },
    {
      id: 'user',
      name: 'Test User',
      role: 'tester',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hello, can you help me solve this problem?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    context: 'Testing problem-solving abilities',
  },

  execution: {
    maxDuration: 300000, // 5 minutes
    maxSteps: 20,
  },

  verification: {
    rules: [
      {
        id: 'provided-solution',
        type: 'llm',
        description: 'Agent provided a valid solution',
        config: {
          criteria: 'The agent provided a correct and helpful solution to the problem',
        },
      },
    ],
  },

  benchmarks: {
    maxDuration: 300000,
    targetAccuracy: 0.8,
  },
};
```

### Actor Types

- **subject**: The agent being tested (uses main runtime)
- **tester**: Controls the testing flow, asks questions
- **participant**: Other actors in the scenario (simulated users)

### Script Steps

```typescript
{
  type: 'message',
  content: 'Send this message'
},
{
  type: 'wait',
  waitTime: 5000 // Wait 5 seconds
},
{
  type: 'action',
  actionName: 'RESEARCH',
  actionParams: { query: 'renewable energy' }
}
```

### Verification Rules

#### LLM-based Verification

```typescript
{
  id: 'quality-check',
  type: 'llm',
  description: 'Response quality assessment',
  config: {
    criteria: 'The response was accurate, helpful, and well-structured'
  }
}
```

#### Rule-based Verification

```typescript
{
  id: 'contains-keyword',
  type: 'contains',
  description: 'Response contains required information',
  config: {
    expectedValue: 'renewable energy'
  }
},
{
  id: 'response-time',
  type: 'timing',
  description: 'Responded within time limit',
  config: {
    threshold: 30000 // 30 seconds
  }
}
```

## Built-in Scenarios

The framework includes several example scenarios:

### 1. Truth vs Lie Detection

Tests agent's ability to detect deception and inconsistencies in witness testimony.

### 2. Research Task Completion

Evaluates research capabilities and information synthesis.

### 3. Coding Challenge

Tests programming problem-solving and code explanation skills.

### 4. Workflow Planning

Assesses ability to break down complex problems into actionable plans.

## Verification Methods

### LLM Verification

Uses language models to evaluate:

- Response quality and accuracy
- Task completion
- Behavioral appropriateness
- Reasoning correctness

### Rule-based Verification

Programmatic checks for:

- Keyword presence
- Response timing
- Action execution
- Message patterns

### Custom Verification

- Regex pattern matching
- Count-based validation
- Custom functions

## Metrics and Benchmarking

### Collected Metrics

- **Duration**: Total scenario execution time
- **Message Count**: Number of messages exchanged
- **Token Usage**: Input/output tokens consumed
- **Memory Usage**: Peak and average memory consumption
- **Action Counts**: Frequency of different actions taken
- **Response Latency**: Time to generate responses

### Performance Scoring

- **Overall Score**: Weighted average of all verification rules
- **Speed Score**: Based on response times vs benchmarks
- **Accuracy Score**: Based on verification success rate
- **Efficiency Score**: Token and memory usage optimization
- **Reliability Score**: Consistency of performance

## Integration with CI/CD

Example GitHub Actions workflow:

```yaml
name: Agent Scenario Tests
on: [push, pull_request]

jobs:
  scenario-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Run scenario tests
        run: |
          elizaos scenario --benchmark \
            --output scenario-results.json \
            --format json

      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: scenario-results
          path: scenario-results.json
```

## Best Practices

### Scenario Design

1. **Clear Objectives**: Define what capabilities you're testing
2. **Realistic Interactions**: Use natural conversation patterns
3. **Appropriate Complexity**: Match scenario complexity to capabilities being tested
4. **Deterministic Outcomes**: Ensure scenarios have clear success criteria

### Verification Strategy

1. **Multiple Rules**: Use both LLM and rule-based verification
2. **Weighted Importance**: Assign weights based on rule importance
3. **Clear Criteria**: Write specific, testable verification criteria
4. **Ground Truth**: Establish clear expected outcomes

### Performance Optimization

1. **Parallel Execution**: Use `--parallel` for faster test runs
2. **Resource Limits**: Set appropriate timeouts and resource constraints
3. **Selective Testing**: Use filters to run subset of scenarios
4. **Continuous Monitoring**: Track performance trends over time

## Troubleshooting

### Common Issues

1. **Timeout Errors**: Increase `maxDuration` in scenario execution config
2. **Verification Failures**: Check LLM prompt clarity and criteria specificity
3. **Actor Runtime Issues**: Ensure proper character configuration
4. **Memory Issues**: Use `--max-concurrency` to limit parallel scenarios

### Debug Mode

```bash
elizaos scenario --verbose --scenario ./debug-scenario.ts
```

### Logs and Output

- Detailed logs in CLI output
- JSON/HTML reports for analysis
- Performance metrics for optimization

## Extension Points

### Custom Verification Rules

Implement custom verification logic:

```typescript
{
  id: 'custom-check',
  type: 'custom',
  config: {
    customFunction: 'validateSpecialRequirement'
  }
}
```

### Custom Metrics

Add domain-specific metrics:

```typescript
benchmarks: {
  customMetrics: ['domain_expertise', 'ethical_reasoning'];
}
```

### Custom Actors

Create specialized actor behaviors for your testing needs.

## Future Enhancements

- Multi-modal scenario support (voice, images)
- Distributed scenario execution
- Real-time monitoring dashboard
- Automated scenario generation
- Integration with external testing frameworks
- Performance regression detection
