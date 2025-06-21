# ElizaOS Planning Enhancement Report

## Executive Summary

This report analyzes the current planning capabilities in ElizaOS and proposes comprehensive enhancements to create a robust, testable, and benchmarkable planning system. The goal is to enable agents to intelligently plan multi-step actions, chain them together with state passing, and provide measurable improvements in planning effectiveness.

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Identified Gaps](#identified-gaps)
3. [Proposed Approaches](#proposed-approaches)
4. [Implementation Strategy](#implementation-strategy)
5. [Testing & Benchmarking Framework](#testing--benchmarking-framework)
6. [Success Metrics](#success-metrics)

## Current State Analysis

### 1. Core Runtime Planning (packages/core/src/runtime.ts)

The current `processActions` implementation provides basic sequential action execution with:

**Strengths:**

- ActionContext support for passing state between actions
- Working memory integration
- Previous results tracking
- Error handling with continuation options

**Limitations:**

- No intelligent planning phase - actions are executed as specified by the LLM
- Limited provider selection during action execution
- No re-planning capabilities
- No parallel execution support

### 2. Planning Plugin (packages/plugin-planning)

The planning plugin demonstrates action chaining concepts but lacks:

**Current Features:**

- Basic action chaining examples
- Simple message classification
- State passing between actions

**Missing Components:**

- No actual planning logic
- No integration with LLM for plan generation
- No plan validation or optimization
- No benchmarking capabilities

### 3. Message Handler Planning

The message received handler in `plugin-message-handling` shows:

- Basic action selection via LLM
- Provider selection capability
- Simple retry logic

But lacks:

- Multi-step planning
- Dynamic provider injection
- Plan adaptation based on results

## Identified Gaps

### 1. Planning Intelligence

- No dedicated planning phase before action execution
- No plan generation based on goals
- No plan optimization or validation

### 2. State Management

- Limited state passing between actions
- No persistent plan state across conversations
- No plan history or learning

### 3. Testing & Benchmarking

- No planning-specific tests
- No benchmarking framework
- No metrics for plan quality

### 4. Architecture

- Planning logic scattered across plugins
- No unified planning interface
- Limited extensibility

## Proposed Approaches

### Approach 1: Enhanced Core Planning (Recommended)

**Description:** Enhance the core runtime with a dedicated planning phase that occurs before action execution.

**Pros:**

- Centralized planning logic
- Available to all plugins
- Consistent behavior across agents

**Cons:**

- Requires core modifications
- Potential breaking changes

**Implementation:**

```typescript
// In core/src/runtime.ts
interface PlanningResult {
  plan: ActionPlan;
  providers: string[];
  confidence: number;
}

async planActions(
  message: Memory,
  state: State,
  goal?: string
): Promise<PlanningResult> {
  // Use LLM to generate plan
  // Validate plan feasibility
  // Optimize execution order
  // Select required providers
}
```

### Approach 2: Planning Service Architecture

**Description:** Create a dedicated PlanningService that can be registered and used by any plugin.

**Pros:**

- Modular and reusable
- No core changes needed
- Easy to test independently

**Cons:**

- Requires service registration
- May duplicate some core functionality

### Approach 3: Enhanced Planning Plugin

**Description:** Expand the planning plugin to be a comprehensive planning solution.

**Pros:**

- Plugin isolation
- Easy to iterate
- No core dependencies

**Cons:**

- Limited to plugin users
- May not integrate well with core

### Approach 4: Hybrid Approach (Recommended Secondary)

**Description:** Implement core planning capabilities with an enhanced planning plugin for advanced features.

**Pros:**

- Best of both worlds
- Progressive enhancement
- Backward compatibility

**Cons:**

- More complex implementation
- Potential duplication

## Implementation Strategy

### Phase 1: Core Planning Enhancement

#### 1.1 Planning Types Enhancement

```typescript
// core/src/types/planning.ts additions
export interface PlanningContext {
  goal: string;
  constraints: Constraint[];
  availableActions: string[];
  availableProviders: string[];
  historicalPlans?: ActionPlan[];
  preferences?: PlanningPreferences;
}

export interface PlanningPreferences {
  maxSteps?: number;
  preferredExecutionModel?: 'sequential' | 'parallel';
  optimizeFor?: 'speed' | 'accuracy' | 'cost';
  allowReplanning?: boolean;
}

export interface PlanEvaluation {
  planId: UUID;
  score: number;
  metrics: {
    completeness: number;
    efficiency: number;
    feasibility: number;
    resourceUsage: number;
  };
  issues?: string[];
  suggestions?: string[];
}
```

#### 1.2 Core Runtime Planning Methods

```typescript
// core/src/runtime.ts additions
class AgentRuntime {
  async generatePlan(message: Memory, context: PlanningContext): Promise<ActionPlan> {
    // Compose planning state
    const planningState = await this.composeState(message, [
      'ACTIONS',
      'PROVIDERS',
      'ACTION_STATE',
      'PLANNING_HISTORY',
    ]);

    // Generate plan using LLM
    const planPrompt = composePlanningPrompt(context, planningState);
    const planResponse = await this.useModel(ModelType.TEXT_REASONING_LARGE, {
      prompt: planPrompt,
      temperature: 0.7,
    });

    // Parse and validate plan
    const plan = parsePlan(planResponse);
    await this.validatePlan(plan);

    return plan;
  }

  async executePlan(
    plan: ActionPlan,
    message: Memory,
    callback?: HandlerCallback
  ): Promise<PlanExecutionResult> {
    const executionContext = new PlanExecutionContext(plan);

    for (const step of plan.steps) {
      if (executionContext.shouldAbort()) break;

      await this.executeStep(step, executionContext, message, callback);

      if (step.onError === 'abort' && executionContext.hasError()) {
        break;
      }
    }

    return executionContext.getResult();
  }
}
```

### Phase 2: Planning Plugin Enhancement

#### 2.1 Strategy Service

```typescript
// plugin-planning/src/services/StrategyService.ts
export class StrategyService extends Service {
  static serviceType = 'strategy';

  async createStrategy(goal: string, context: StrategyContext): Promise<Strategy> {
    // Analyze goal
    const analysis = await this.analyzeGoal(goal);

    // Generate multiple strategy options
    const strategies = await this.generateStrategies(analysis, context);

    // Evaluate and rank strategies
    const rankedStrategies = await this.evaluateStrategies(strategies);

    // Return best strategy
    return rankedStrategies[0];
  }

  async adaptStrategy(strategy: Strategy, feedback: StrategyFeedback): Promise<Strategy> {
    // Adjust strategy based on execution feedback
    return this.optimizeStrategy(strategy, feedback);
  }
}
```

#### 2.2 Planning Actions

```typescript
// plugin-planning/src/actions/plan.ts
export const createPlanAction: Action = {
  name: 'CREATE_PLAN',
  description: 'Creates a multi-step action plan to achieve a goal',

  handler: async (runtime, message, state, options, callback) => {
    const goal = extractGoal(message.content.text);

    const plan = await runtime.generatePlan(message, {
      goal,
      constraints: [],
      availableActions: runtime.actions.map((a) => a.name),
      availableProviders: runtime.providers.map((p) => p.name),
    });

    // Store plan in working memory
    const context = options?.context as ActionContext;
    context?.updateMemory?.('currentPlan', plan);

    await callback({
      text: `I've created a ${plan.steps.length}-step plan to ${goal}`,
      thought: `Plan generated with ${plan.executionModel} execution model`,
      actions: ['CREATE_PLAN'],
      plan: plan,
    });

    return {
      success: true,
      data: { plan },
      values: { planId: plan.id },
      nextActions: plan.steps.map((s) => s.actionName),
    };
  },
};
```

### Phase 3: Testing & Benchmarking Framework

#### 3.1 Test Scenarios

```typescript
// packages/core/src/__tests__/planning.test.ts
describe('Planning System', () => {
  const testScenarios: PlanningScenario[] = [
    {
      name: 'Simple Sequential Plan',
      goal: 'Send an email with weather information',
      expectedActions: ['GET_WEATHER', 'COMPOSE_EMAIL', 'SEND_EMAIL'],
      constraints: { maxSteps: 5 },
      successCriteria: {
        completesGoal: true,
        usesCorrectActions: true,
        respectsConstraints: true,
      },
    },
    {
      name: 'Complex Parallel Plan',
      goal: 'Analyze market data and prepare investment report',
      expectedActions: [
        ['FETCH_MARKET_DATA', 'FETCH_NEWS'], // Parallel
        'ANALYZE_DATA',
        'GENERATE_INSIGHTS',
        'CREATE_REPORT',
      ],
      constraints: { maxDuration: 5000 },
      successCriteria: {
        parallelization: true,
        dataIntegration: true,
        reportQuality: 0.8,
      },
    },
    {
      name: 'Adaptive Plan with Failure',
      goal: 'Transfer funds with fallback options',
      mockFailures: ['TRANSFER_PRIMARY'],
      expectedAdaptation: ['TRANSFER_SECONDARY', 'NOTIFY_USER'],
      successCriteria: {
        handlesFailure: true,
        achievesGoalAlternatively: true,
      },
    },
  ];

  describe('Plan Generation', () => {
    testScenarios.forEach((scenario) => {
      it(`should generate correct plan for: ${scenario.name}`, async () => {
        const runtime = createMockRuntime(scenario.mockActions);
        const plan = await runtime.generatePlan(createMockMessage(scenario.goal), {
          goal: scenario.goal,
          constraints: scenario.constraints,
        });

        expect(plan.steps.map((s) => s.actionName)).toMatchPattern(scenario.expectedActions);
      });
    });
  });

  describe('Plan Execution', () => {
    testScenarios.forEach((scenario) => {
      it(`should execute plan successfully: ${scenario.name}`, async () => {
        const runtime = createMockRuntime(scenario.mockActions);
        const plan = await runtime.generatePlan(createMockMessage(scenario.goal), {
          goal: scenario.goal,
        });

        const result = await runtime.executePlan(plan, mockMessage);

        expect(result.success).toBe(true);
        expect(result.completedSteps).toBe(plan.steps.length);
      });
    });
  });
});
```

#### 3.2 Benchmarking System

```typescript
// packages/core/src/benchmarks/planning.benchmark.ts
export class PlanningBenchmark {
  private scenarios: BenchmarkScenario[];
  private results: BenchmarkResults;

  async runBenchmark(iterations: number = 10): Promise<BenchmarkReport> {
    for (const scenario of this.scenarios) {
      const scenarioResults = [];

      for (let i = 0; i < iterations; i++) {
        const result = await this.runScenario(scenario);
        scenarioResults.push(result);
      }

      this.results[scenario.name] = this.analyzeResults(scenarioResults);
    }

    return this.generateReport();
  }

  private analyzeResults(results: ScenarioResult[]): Analysis {
    return {
      successRate: results.filter((r) => r.success).length / results.length,
      averageSteps: average(results.map((r) => r.steps)),
      averageDuration: average(results.map((r) => r.duration)),
      planQuality: average(results.map((r) => r.qualityScore)),
      adaptationRate: results.filter((r) => r.adapted).length / results.length,
    };
  }

  async saveResults(filepath: string): Promise<void> {
    const report = {
      timestamp: Date.now(),
      iterations: this.iterations,
      results: this.results,
      summary: this.generateSummary(),
    };

    await fs.writeFile(filepath, JSON.stringify(report, null, 2));
  }
}
```

### Phase 4: Integration & Migration

#### 4.1 Message Handler Integration

```typescript
// plugin-message-handling/src/events.ts enhancement
if (shouldRespond) {
  // New planning phase
  if (runtime.character.settings?.enablePlanning) {
    const planningContext = {
      goal: extractGoalFromMessage(message),
      constraints: getConstraintsFromSettings(runtime.character.settings),
      availableActions: state.values.actionNames,
      availableProviders: runtime.providers.map((p) => p.name),
    };

    const plan = await runtime.generatePlan(message, planningContext);

    // Execute plan instead of single action
    const planResult = await runtime.executePlan(plan, message, callback);

    // Store plan results for evaluation
    await runtime.createMemory(
      {
        content: {
          type: 'plan_execution',
          plan: plan,
          result: planResult,
        },
        entityId: runtime.agentId,
        roomId: message.roomId,
      },
      'plans'
    );
  } else {
    // Existing single-action logic
    await runtime.processActions(message, responseMessages, state, callback);
  }
}
```

## Testing & Benchmarking Framework

### Test Categories

1. **Unit Tests**: Test individual planning components
2. **Integration Tests**: Test planning with real actions
3. **Benchmark Tests**: Measure planning quality over iterations
4. **Regression Tests**: Ensure improvements don't break existing functionality

### Benchmark Metrics

1. **Planning Success Rate**: % of plans that achieve their goal
2. **Efficiency Score**: Steps taken vs optimal steps
3. **Adaptation Rate**: % of plans that successfully adapt to failures
4. **Resource Usage**: Tokens/API calls used in planning
5. **Execution Time**: Total time from goal to completion

### Test Scenarios

```typescript
const testScenarios = [
  {
    id: 'data-pipeline',
    goal: 'Fetch data from API, process it, and store results',
    complexity: 'medium',
    expectedSteps: 3 - 5,
    requiredCapabilities: ['API_CALL', 'DATA_PROCESSING', 'STORAGE'],
  },
  {
    id: 'multi-source-analysis',
    goal: 'Analyze sentiment from multiple social media sources',
    complexity: 'high',
    expectedSteps: 5 - 8,
    parallelizable: true,
  },
  {
    id: 'transaction-with-confirmation',
    goal: 'Send payment and wait for confirmation',
    complexity: 'medium',
    requiresState: true,
    hasTimeout: true,
  },
];
```

## Success Metrics

### Phase 1 Success Criteria (Core Planning)

- [ ] Plan generation works for 90% of test scenarios
- [ ] Plans execute successfully 80% of the time
- [ ] Core tests pass without regression
- [ ] Planning adds <500ms overhead

### Phase 2 Success Criteria (Plugin Enhancement)

- [ ] Strategy service generates valid strategies
- [ ] Plans can adapt to failures
- [ ] Benchmarking system produces consistent results
- [ ] 10+ test scenarios pass consistently

### Phase 3 Success Criteria (Full Integration)

- [ ] Planning improves goal achievement by 25%
- [ ] Average steps to goal reduced by 20%
- [ ] Planning works across all major plugins
- [ ] Benchmark suite runs in CI/CD

### Long-term Success Metrics

- Planning success rate > 85%
- User satisfaction with multi-step tasks improved
- Developer adoption of planning APIs
- Community-contributed planning strategies

## Implementation Timeline

### Week 1-2: Core Planning Enhancement

- Implement planning types
- Add planning methods to runtime
- Create basic plan generation
- Write core planning tests

### Week 3-4: Planning Plugin Development

- Implement StrategyService
- Create planning actions
- Add plan adaptation logic
- Integrate with core planning

### Week 5-6: Testing & Benchmarking

- Develop test scenarios
- Implement benchmark framework
- Create benchmark reports
- Add CI/CD integration

### Week 7-8: Integration & Documentation

- Integrate with message handler
- Update existing plugins
- Write documentation
- Create migration guide

## Risk Mitigation

1. **Breaking Changes**: Use feature flags for gradual rollout
2. **Performance Impact**: Implement caching and optimization
3. **Complexity**: Provide simple defaults and progressive disclosure
4. **Adoption**: Create compelling examples and documentation

## Conclusion

This comprehensive planning enhancement will transform ElizaOS agents from reactive responders to proactive planners. By implementing intelligent planning at the core level while providing advanced capabilities through plugins, we create a flexible system that can adapt to various use cases while maintaining simplicity for basic operations.

The testing and benchmarking framework ensures that improvements are measurable and that the system continues to improve over time. With proper implementation and testing, this enhancement will significantly improve the agent's ability to handle complex, multi-step tasks.
