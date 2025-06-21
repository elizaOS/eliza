# Plugin Test Scenarios

This directory contains 50 comprehensive test scenarios for testing various plugin combinations and workflows in the Eliza framework.

## Overview

Each scenario is designed to test specific plugin functionality and integration patterns. The scenarios follow a consistent structure with actors, verification rules, and benchmarks.

## Scenario Categories

### 1. Research & Knowledge Management

- **01-research-knowledge-integration**: Academic paper research with knowledge base storage
- **12-knowledge-graph**: Building comprehensive knowledge graphs from web sources
- **21, 26, 31, 36, 41, 46-research-synthesis**: Various research synthesis workflows

### 2. GitHub & Project Management

- **02-github-todo-workflow**: GitHub issue to todo task management
- **10-automated-deployment**: Automated deployment pipeline with GitHub integration
- **19-bug-triage**: Bug triage and assignment workflow

### 3. Blockchain & DeFi

- **06-blockchain-defi-workflow**: Cross-chain DeFi operations and portfolio management
- **13-blockchain-analytics**: Cross-chain DeFi analytics and risk assessment
- **20-cross-chain-assets**: Cross-chain asset management
- **23, 28, 33, 38, 43, 48-defi-strategy**: Various DeFi strategy implementations

### 4. Security & Secrets Management

- **08-secrets-security-workflow**: Secure credential management and rotation
- **16-smart-contract-audit**: Smart contract security auditing
- **22, 27, 32, 37, 42, 47-security-audit**: Various security audit workflows

### 5. Web Research & Automation

- **05-stagehand-web-research**: Web scraping and data extraction
- **09-complex-investigation**: Multi-source investigation and analysis
- **11-crisis-response**: Crisis response coordination
- **14-competitive-intelligence**: Competitive intelligence gathering
- **15-automated-documentation**: Automated documentation generation
- **18-social-media-analysis**: Social media sentiment analysis

### 6. Entity & Relationship Management

- **04-rolodex-relationship-management**: Entity and relationship tracking
- **24, 29, 34, 39, 44, 49-entity-mapping**: Various entity mapping workflows

### 7. Planning & Execution

- **03-planning-execution**: Multi-plugin planning and execution
- **07-plugin-manager-system**: Plugin dependency management
- **17-dependency-resolution**: Dependency resolution workflow
- **25, 30, 35, 40, 45, 50-automation-workflow**: Various automation workflows

## Scenario Structure

Each scenario includes:

1. **Actors**: Subject (agent being tested) and Tester (simulated user)
2. **Setup**: Environment configuration and plugin requirements
3. **Execution**: Steps, timing, and stop conditions
4. **Verification**: Rules for validating correct behavior
5. **Benchmarks**: Performance metrics and custom measurements

## Usage

Import scenarios from the index file:

```typescript
import { pluginTestScenarios } from './scenarios/plugin-tests/index.js';

// Run all scenarios
for (const scenario of pluginTestScenarios) {
  await runScenario(scenario);
}
```

## Key Features

- **Multi-plugin Integration**: Tests complex interactions between multiple plugins
- **Action Chaining**: Validates proper sequencing of plugin actions
- **LLM Verification**: Uses LLM-based checks for quality assessment
- **Performance Benchmarks**: Measures execution time, token usage, and custom metrics
- **Realistic Workflows**: Simulates real-world use cases and user interactions

## Verification Types

- `action_taken`: Verifies specific actions were executed
- `contains`: Checks for specific content in responses
- `llm`: Uses LLM to evaluate quality and correctness
- `regex`: Pattern matching verification
- `count`: Validates occurrence counts
- `timing`: Checks timing constraints

## Custom Metrics

Each scenario can define custom metrics for evaluation:

- Accuracy metrics (e.g., `issue_tracking_accuracy`)
- Quality metrics (e.g., `research_quality`)
- Efficiency metrics (e.g., `workflow_completion_rate`)
- Domain-specific metrics (e.g., `risk_assessment_quality`)

## Running the Scenarios

```bash
# Run all plugin test scenarios
elizaos scenario --directory ./packages/cli/scenarios/plugin-tests

# Run specific scenario
elizaos scenario --scenario ./packages/cli/scenarios/plugin-tests/01-research-knowledge-integration.ts

# Run with benchmarking
elizaos scenario --directory ./packages/cli/scenarios/plugin-tests --benchmark

# Run scenarios matching a pattern
elizaos scenario --directory ./packages/cli/scenarios/plugin-tests --filter "defi"

# Generate detailed HTML report
elizaos scenario --directory ./packages/cli/scenarios/plugin-tests --output plugin-test-results.html --format html
```

## Success Metrics

Each scenario includes:

- **Action verification**: Confirms specific actions were taken
- **LLM verification**: Evaluates quality of outputs
- **Timing constraints**: Ensures reasonable performance
- **Custom metrics**: Scenario-specific success criteria

## Expected Outcomes

Successful execution demonstrates:

1. **Plugin Integration**: Multiple plugins working seamlessly together
2. **Action Chaining**: Complex workflows executed through action sequences
3. **Error Handling**: Graceful handling of edge cases
4. **Performance**: Reasonable execution times under load
5. **Reliability**: Consistent results across runs

## Extending the Test Suite

To add new scenarios:

1. Create a new TypeScript file following the naming convention: `XX-scenario-name.ts`
2. Implement the `Scenario` interface from `@elizaos/core`
3. Focus on multi-plugin integration and action chaining
4. Add comprehensive verification rules
5. Update this README with the new scenario

## Troubleshooting

Common issues:

- **Plugin not available**: Ensure all required plugins are installed
- **Action not found**: Verify action names match plugin implementations
- **Timeout errors**: Increase `maxDuration` for complex scenarios
- **Verification failures**: Check LLM criteria match expected behavior

## Summary

These 50 scenarios provide comprehensive testing of ElizaOS plugin capabilities, focusing on:

- Real-world use cases
- Complex multi-plugin workflows
- Action chaining and coordination
- Edge case handling
- Performance under load

Regular execution of these scenarios ensures plugin ecosystem health and identifies integration issues early.
