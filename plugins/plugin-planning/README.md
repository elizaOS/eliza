# ElizaOS Planning Plugin & Benchmark System

A comprehensive planning and execution system for ElizaOS agents with state-of-the-art benchmarking capabilities against REALM-Bench and API-Bank test suites.

## Overview

This plugin provides a unified planning service that enables ElizaOS agents to:

- **Break down complex requests** into actionable step-by-step plans
- **Execute plans efficiently** with different execution models (sequential, parallel, DAG)
- **Adapt plans dynamically** when execution encounters errors or changing conditions
- **Validate planning capabilities** against established benchmarks (REALM-Bench, API-Bank)
- **Benchmark performance** with comprehensive metrics and reporting

## Key Features

### 🎯 Unified Planning Service

- **IPlanningService Interface**: Standardized planning contract in core package
- **PlanningService Implementation**: Production-ready service with full runtime integration
- **Message Handler Integration**: Seamless fallback from inline planning to service-based planning
- **Action Plan Execution**: Support for sequential, parallel, and DAG execution models

### 📊 Comprehensive Benchmarking

- **REALM-Bench Integration**: Tests planning patterns (sequential, reactive, complex multi-step)
- **API-Bank Integration**: Tests tool-use scenarios across 3 complexity levels
- **Real Runtime Testing**: Uses actual agent runtime with real providers and context
- **Performance Metrics**: Token usage, response latency, memory usage, plan quality

### 🔧 Production-Ready Features

- **Error Handling**: Robust error handling with plan adaptation and recovery
- **Working Memory**: Maintains state across plan execution steps
- **Validation**: Plan structure validation and feasibility checking
- **Monitoring**: Comprehensive logging and metrics collection

## Installation

```bash
# Install the plugin
npm install @elizaos/plugin-planning

# Add to your character's plugins array
{
  "plugins": ["@elizaos/plugin-planning"]
}
```

## Quick Start

### Basic Usage

```typescript
import { planningPlugin } from '@elizaos/plugin-planning';

// The plugin automatically registers the planning service
// Message handling will use the planning service when available
```

### Running Benchmarks

```bash
# Run all benchmarks with default settings
npm run benchmark

# Run with custom character and specific benchmark data
npm run benchmark -- --character ./my-character.json --realm-bench ./realm-bench-data

# Run API-Bank only with verbose output
npm run benchmark -- --api-bank ./api-bank-data --verbose --max-tests 50

# Quick test run
npm run benchmark:quick
```

## Architecture

### Planning Service Flow

```
User Request → Message Handler → Planning Service → Plan Creation → Plan Execution → Response
                     ↓                                    ↓              ↓
              Fallback to inline              Comprehensive        Working Memory
              planning if service             planning with        & State Management
              unavailable                     context analysis
```

### Execution Models

1. **Sequential**: Steps execute one after another (default)
2. **Parallel**: Independent steps execute simultaneously
3. **DAG**: Complex dependency-aware execution with cycle detection

### Plan Structure

```typescript
interface ActionPlan {
  id: UUID;
  goal: string;
  steps: PlanStep[];
  executionModel: 'sequential' | 'parallel' | 'dag';
  constraints: PlanConstraint[];
  createdAt: number;
  estimatedDuration: number;
}
```

## Benchmarking

### REALM-Bench Tests

Tests planning capabilities across different patterns:

- **Sequential**: Simple step-by-step task execution
- **Reactive**: Dynamic response to changing conditions
- **Complex**: Multi-step reasoning with dependencies

### API-Bank Tests

Tests tool-use scenarios across 3 levels:

- **Level 1**: Single API calls with simple parameters
- **Level 2**: Multiple API calls with parameter dependencies
- **Level 3**: Complex multi-turn scenarios with conditional logic

### Metrics Collected

- **Success Rates**: Overall and per-category success percentages
- **Planning Quality**: LLM-evaluated plan structure and feasibility
- **API Accuracy**: Correct tool selection and parameter extraction
- **Response Quality**: ROUGE-L scores for response relevance
- **Performance**: Planning time, execution time, memory usage

## Configuration

### Character Configuration

```json
{
  "name": "PlanningAgent",
  "plugins": ["@elizaos/plugin-planning"],
  "system": "You are a planning-focused agent...",
  "bio": ["I excel at breaking down complex tasks..."],
  "topics": ["planning", "task management", "coordination"]
}
```

### Benchmark Configuration

```typescript
const config: BenchmarkConfig = {
  character: myCharacter,
  plugins: [planningPlugin],
  runRealmBench: true,
  runApiBank: true,
  maxTestsPerCategory: 100,
  timeoutMs: 60000,
  outputDir: './benchmark-results',
  enableMetrics: true,
};
```

## API Reference

### IPlanningService Interface

```typescript
interface IPlanningService {
  // Simple planning for basic tasks
  createSimplePlan(runtime: IAgentRuntime, message: Memory, state: State): Promise<ActionPlan>;

  // Comprehensive planning with context
  createComprehensivePlan(
    runtime: IAgentRuntime,
    context: PlanningContext,
    message: Memory,
    state: State
  ): Promise<ActionPlan>;

  // Execute plans with callback handling
  executePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    message: Memory,
    callback: HandlerCallback
  ): Promise<PlanExecutionResult>;

  // Validate plan structure and feasibility
  validatePlan(runtime: IAgentRuntime, plan: ActionPlan): Promise<PlanValidationResult>;

  // Adapt plans when execution fails
  adaptPlan(
    runtime: IAgentRuntime,
    originalPlan: ActionPlan,
    failureContext: PlanFailureContext
  ): Promise<ActionPlan>;
}
```

### BenchmarkRunner

```typescript
const runner = new BenchmarkRunner(config);
const results = await runner.runBenchmarks();

// Results include comprehensive metrics and analysis
console.log(`Success Rate: ${results.overallMetrics.overallSuccessRate}`);
console.log(`Performance Score: ${results.summary.performanceScore}/100`);
```

## Examples

### Basic Planning Request

```typescript
// User: "Send an email to John about the meeting"
// → Creates plan with SEND_EMAIL action
// → Executes sequentially with parameter extraction
```

### Complex Multi-Step Request

```typescript
// User: "Research climate change, analyze trends, and create a summary report"
// → Creates comprehensive plan:
//   1. SEARCH for climate change data
//   2. ANALYZE collected information
//   3. COMPILE_REPORT with findings
// → Executes with working memory to maintain context
```

### Tool-Use Scenario

```typescript
// User: "Book a restaurant reservation after checking my calendar"
// → Creates DAG plan with dependencies:
//   1. GET_CALENDAR_AVAILABILITY
//   2. SEARCH_RESTAURANTS (depends on #1)
//   3. MAKE_RESERVATION (depends on #2)
```

## Benchmark Results

Example benchmark output:

```
🎯 PLANNING BENCHMARK RESULTS
═══════════════════════════════════════════════════════
📊 Overall Performance: 87/100
✅ Success Rate: 78.5%
📈 Tests Passed: 157/200
⚡ Avg Planning Time: 1,247ms
🚀 Avg Execution Time: 2,156ms

🔍 Key Findings:
• Strong performance in sequential planning pattern
• High-quality plan generation capabilities
• Multiple strength areas identified

📋 REALM-Bench Results:
  Success Rate: 82.1%
  Tests: 82/100
  Plan Quality: 85.3%

🔧 API-Bank Results:
  Success Rate: 75.0%
  Tests: 75/100
  API Call Accuracy: 78.9%
  Response Quality: 71.2%
```

## Development

### Project Structure

```
packages/plugin-planning/
├── src/
│   ├── services/
│   │   └── planning-service.ts     # Core planning implementation
│   ├── benchmarks/
│   │   ├── realm-bench-adapter.ts  # REALM-Bench integration
│   │   ├── api-bank-adapter.ts     # API-Bank integration
│   │   └── benchmark-runner.ts     # Orchestrates all benchmarks
│   ├── cli/
│   │   └── benchmark-command.ts    # CLI interface
│   ├── __tests__/
│   │   ├── planning-integration.test.ts
│   │   └── test-utils.ts
│   └── index.ts                    # Plugin export
├── scripts/
│   └── run-benchmarks.ts           # Comprehensive benchmark runner
└── README.md                       # This file
```

### Testing

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run benchmarks
npm run benchmark

# Quick benchmark test
npm run benchmark:quick
```

### Contributing

1. **Fork the repository**
2. **Create a feature branch**
3. **Add tests for new functionality**
4. **Run the full test suite**
5. **Submit a pull request**

## Performance Considerations

- **Planning Time**: Typically 1-3 seconds for complex plans
- **Memory Usage**: Maintains working memory state for plan execution
- **Token Consumption**: Optimized prompts for efficient LLM usage
- **Scalability**: Handles plans with 100+ steps efficiently

## Troubleshooting

### Common Issues

**Planning Service Not Available**

```typescript
// Check if service is registered
const planningService = runtime.getService<IPlanningService>('planning');
if (!planningService) {
  // Falls back to inline planning in message handler
}
```

**Benchmark Data Not Found**

```bash
# Ensure benchmark data is available
mkdir -p benchmark-data/realm-bench
mkdir -p benchmark-data/api-bank
# Copy test data to these directories
```

**High Planning Latency**

- Reduce `maxSteps` in planning preferences
- Use smaller LLM models for simple plans
- Enable plan caching for repeated patterns

## License

MIT License - see LICENSE file for details.

## Related Packages

- **@elizaos/core**: Core ElizaOS framework
- **@elizaos/plugin-sql**: Database integration
- **@elizaos/plugin-message-handling**: Message processing

## Resources

- [REALM-Bench Paper](https://github.com/genglongling/REALM-Bench)
- [API-Bank Paper](https://github.com/AlibabaResearch/DAMO-ConvAI/tree/main/api-bank)
- [ElizaOS Documentation](https://elizaos.github.io/docs)
- [Planning Theory and Practice](https://planning.wiki)
