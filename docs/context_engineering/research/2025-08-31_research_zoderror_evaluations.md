# Research: ZodError in Scenario Evaluations

**Date**: 2025-08-31 10:46:28 UTC
**Repository**: ElizaOS
**Branch**: dynamic-prompting

## Research Question
Why is a ZodError occurring during scenario execution with the message "Required" for `evaluator_type`, `summary`, and `details` fields in evaluations?

## Key Findings

### 1. **Root Cause: Legacy Evaluation System**
- **Location**: `packages/cli/src/commands/scenario/src/ConversationManager.ts:124-139`
- **Description**: The `ConversationManager.executeTurn()` method is using the legacy `evaluationEngine.runEvaluations()` instead of the enhanced `runEnhancedEvaluations()` method
- **Significance**: Legacy evaluations return `{ success: boolean, message: string }` format, but the schema expects `{ evaluator_type: string, success: boolean, summary: string, details: object }`

### 2. **Schema Validation Mismatch**
- **Location**: `packages/cli/src/commands/scenario/src/schema.ts:27-33`
- **Description**: The `EnhancedEvaluationResultSchema` requires specific fields that legacy evaluations don't provide
- **Significance**: This causes Zod validation to fail when the data aggregator tries to validate the result

### 3. **TrajectoryReconstructor Failure**
- **Location**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts:290`
- **Description**: The TrajectoryReconstructor is failing to find any trajectory steps after 3 attempts
- **Significance**: This results in empty trajectory data, but doesn't directly cause the ZodError

### 4. **Data Aggregator Validation**
- **Location**: `packages/cli/src/commands/scenario/src/data-aggregator.ts:163`
- **Description**: The `buildResult()` method validates the final result against `ScenarioRunResultSchema`
- **Significance**: This is where the ZodError is actually thrown when evaluations don't match the expected format

## Architecture Insights

### Current Implementation
- **Patterns**: The system has both legacy and enhanced evaluation engines, but not all code paths use the enhanced version
- **Integration**: `ConversationManager` uses legacy evaluations while other parts of the system use enhanced evaluations
- **Dependencies**: The data aggregator expects enhanced evaluation format regardless of which evaluation engine was used

### Gaps and Opportunities
- **Missing**: Consistent use of enhanced evaluations across all code paths
- **Improvements**: Update `ConversationManager` to use `runEnhancedEvaluations()` instead of `runEvaluations()`
- **Risks**: The current implementation can fail validation even when evaluations technically "succeed"

## Detailed Analysis

### The Error Chain
1. **ConversationManager.executeTurn()** calls `evaluationEngine.runEvaluations()` (legacy)
2. **Legacy evaluations** return `{ success: boolean, message: string }` format
3. **Data aggregator** expects `EnhancedEvaluationResult[]` format with required fields
4. **Zod validation** fails because `evaluator_type`, `summary`, and `details` are undefined

### The Fix
The `ConversationManager` should be updated to use the enhanced evaluation system:

```typescript
// Current (problematic):
finalEvaluations = await this.evaluationEngine.runEvaluations(
    config.final_evaluations,
    combinedResult
);

// Should be:
finalEvaluations = await this.evaluationEngine.runEnhancedEvaluations(
    config.final_evaluations,
    combinedResult
);
```

### TrajectoryReconstructor Issue
The TrajectoryReconstructor is failing because:
- It's looking for trajectory data in a 30-second window
- The agent may not be generating the expected memory/log entries
- The timing synchronization between agent execution and trajectory reconstruction may be off

## References
- **Files Analyzed**: 
  - `packages/cli/src/commands/scenario/src/ConversationManager.ts`
  - `packages/cli/src/commands/scenario/src/data-aggregator.ts`
  - `packages/cli/src/commands/scenario/src/schema.ts`
  - `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
  - `packages/cli/src/commands/scenario/src/EnhancedEvaluationEngine.ts`
- **Related Research**: Dynamic prompting implementation and evaluation system
- **External Resources**: Zod schema validation documentation

## Next Steps
1. **Immediate Fix**: Update `ConversationManager` to use `runEnhancedEvaluations()`
2. **Investigation**: Debug why TrajectoryReconstructor is not finding trajectory data
3. **Testing**: Verify that the fix resolves the ZodError and maintains functionality
4. **Documentation**: Update any documentation about evaluation system usage
