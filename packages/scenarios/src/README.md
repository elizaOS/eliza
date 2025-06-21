# Scenario Testing Framework

The scenario testing framework enables automated testing of ElizaOS agents by simulating conversations and interactions between multiple actors.

## Features

- **Multi-Actor Support**: Define scenarios with multiple participants (subject, tester, participant roles)
- **Scripted Interactions**: Create step-by-step scripts for actors to follow
- **Flexible Verification**: Both LLM-based and rule-based verification strategies
- **Performance Metrics**: Track response times, completion rates, and custom metrics
- **Isolated Environments**: Each scenario runs in its own world/room for clean testing
- **Multiple Output Formats**: JSON, text, and HTML reports

## Usage

```bash
# Run a specific scenario
elizaos scenario -s scenarios/simple-test.ts

# Run all scenarios in a directory
elizaos scenario -d scenarios/

# Run with detailed metrics
elizaos scenario -s scenarios/truth-vs-lie.ts --benchmark

# Output results to file
elizaos scenario -s scenarios/simple-test.ts -o results.json --format json

# Run scenarios in parallel
elizaos scenario -d scenarios/ --parallel --max-concurrency 5
```

## Creating Scenarios

Scenarios are TypeScript files that export a `Scenario` object:

```typescript
import type { Scenario } from '../src/scenario-runner/types.js';

export const myScenario: Scenario = {
  id: 'unique-id',
  name: 'Scenario Name',
  description: 'What this scenario tests',
  
  actors: [
    {
      id: 'agent',
      name: 'Test Agent',
      role: 'subject', // The agent being tested
      systemPrompt: 'You are a helpful assistant'
    },
    {
      id: 'user',
      name: 'Test User',
      role: 'participant',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hello!',
            timing: 1000
          }
        ]
      }
    }
  ],
  
  verification: {
    rules: [
      {
        id: 'greeting-check',
        type: 'pattern',
        description: 'Agent responds to greeting',
        config: {
          pattern: 'hello|hi|hey',
          mustInclude: true
        }
      }
    ]
  }
};
```

## Available Scenarios

- `simple-test.ts` - Basic connectivity and response test
- `truth-vs-lie.ts` - Deception detection scenario
- `research-task.ts` - Information gathering and analysis
- `workflow-planning.ts` - Multi-step task planning
- `coding-challenge.ts` - Code generation and debugging

## Scenario Structure

### Actors
- **subject**: The agent being tested
- **tester**: An agent that evaluates the subject
- **participant**: Additional actors in the scenario

### Script Steps
- **message**: Send a text message
- **wait**: Pause for a duration
- **action**: Execute an agent action
- **assert**: Check a condition
- **react**: Respond to specific triggers

### Verification Rules
- **pattern**: Check for text patterns
- **llm**: Use LLM to evaluate responses
- **custom**: Custom verification function
- **exact**: Exact text matching
- **sentiment**: Analyze emotional tone

### Metrics
- Response latency
- Token usage
- Step completion times
- Custom metrics per scenario

## Architecture

The scenario framework consists of:

1. **ScenarioRunner**: Main orchestrator
2. **ScenarioVerifier**: Handles verification logic
3. **MetricsCollector**: Tracks performance data
4. **BenchmarkAnalyzer**: Analyzes results against benchmarks

## Notes

- All actors currently share the same runtime for simplicity
- Scenarios run in isolated environments to prevent interference
- The framework integrates with the existing AgentServer infrastructure
- Results can be exported for further analysis

## Future Enhancements

- [ ] Multi-runtime support for true actor isolation
- [ ] Visual scenario builder
- [ ] Real-time monitoring dashboard
- [ ] Automated scenario generation
- [ ] Integration with CI/CD pipelines