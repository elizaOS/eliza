# Implementation Plan: Fix TrajectoryReconstructor and ZodError Issues

**Date**: 2025-08-31
**Repository**: ElizaOS

## Overview
Fix the two critical issues preventing dynamic prompting scenarios from completing successfully:
1. **TrajectoryReconstructor failure**: Room ID mismatch and missing `action_result` memories
2. **ZodError**: Type mismatch between legacy and enhanced evaluation formats

## Current State Analysis
- **TrajectoryReconstructor**: Detects room ID mismatches and finds 0 trajectory steps due to missing `action_result` memories
- **Evaluation System**: Mixed usage of legacy (`EvaluationResult`) and enhanced (`EnhancedEvaluationResult`) formats causing validation failures
- **Data Flow**: `ConversationManager` uses enhanced evaluations but type definitions expect legacy format
- **Memory Generation**: Agents create `messages` type memories but trajectory system expects `action_result` memories

## Desired End State
- **TrajectoryReconstructor**: Successfully reconstructs agent trajectories from available memories
- **Evaluation System**: Consistent use of enhanced evaluation format throughout the data flow
- **Type Safety**: All type definitions align with actual data structures
- **Memory Compatibility**: Trajectory reconstruction works with existing memory types

## What We're NOT Doing
- Rewriting the entire evaluation system
- Changing the agent's memory generation behavior
- Modifying the core ElizaOS runtime
- Adding new evaluation types

## Implementation Approach
**Phase 1**: Fix type system inconsistencies
**Phase 2**: Improve TrajectoryReconstructor robustness
**Phase 3**: Ensure consistent evaluation format usage
**Phase 4**: Add comprehensive testing

## Implementation Phases:

### Phase 1: Fix Type System Inconsistencies
**Overview**: Align type definitions with actual data structures to eliminate ZodError

#### Changes Required:
1. **Update ConversationResult Interface**:
   **File**: `packages/cli/src/commands/scenario/src/conversation-types.ts`
   **Changes**: Change `finalEvaluations: EvaluationResult[]` to `finalEvaluations: EnhancedEvaluationResult[]`

2. **Update ConversationTurn Interface**:
   **File**: `packages/cli/src/commands/scenario/src/conversation-types.ts`
   **Changes**: Change `turnEvaluations: EvaluationResult[]` to `turnEvaluations: EnhancedEvaluationResult[]`

3. **Update ConversationExecutionResult Interface**:
   **File**: `packages/cli/src/commands/scenario/src/conversation-types.ts`
   **Changes**: Change `finalEvaluations: EvaluationResult[]` to `finalEvaluations: EnhancedEvaluationResult[]`

#### Success Criteria:
#### Automated Verification:
- [x] TypeScript compilation succeeds without errors
- [x] All existing tests pass
- [x] No type mismatches in ConversationManager

#### Manual Verification:
- [x] ConversationManager can be instantiated without type errors
- [x] Evaluation results flow correctly through the data pipeline

### Phase 2: Improve TrajectoryReconstructor Robustness
**Overview**: Make trajectory reconstruction work with existing memory types and handle room ID mismatches gracefully

#### Changes Required:
1. **Enhance Memory Type Detection**:
   **File**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
   **Changes**: Add support for `messages` type memories in addition to `action_result` memories

2. **Improve Room ID Handling**:
   **File**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
   **Changes**: Add fallback logic to search across multiple room IDs if primary room ID has no memories

3. **Add Memory Type Conversion**:
   **File**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
   **Changes**: Convert `messages` type memories to trajectory steps when `action_result` memories are not available

#### Success Criteria:
#### Automated Verification:
- [ ] TrajectoryReconstructor tests pass with both memory types
- [ ] Room ID mismatch handling works correctly
- [ ] Memory type conversion produces valid trajectory steps

#### Manual Verification:
- [ ] TrajectoryReconstructor finds trajectory steps in test scenarios
- [ ] Room ID mismatches are handled gracefully without errors

### Phase 3: Ensure Consistent Evaluation Format Usage
**Overview**: Verify that all code paths use the enhanced evaluation format consistently

#### Changes Required:
1. **Audit Evaluation Usage**:
   **File**: `packages/cli/src/commands/scenario/src/ConversationManager.ts`
   **Changes**: Ensure all evaluation calls use `runEnhancedEvaluations()` instead of `runEvaluations()`

2. **Update Test Mocks**:
   **File**: `packages/cli/src/commands/scenario/src/__tests__/ConversationManager.test.ts`
   **Changes**: Update test mocks to return `EnhancedEvaluationResult[]` format

3. **Verify Data Aggregator Compatibility**:
   **File**: `packages/cli/src/commands/scenario/src/data-aggregator.ts`
   **Changes**: Ensure data aggregator properly handles enhanced evaluation format

#### Success Criteria:
#### Automated Verification:
- [ ] All evaluation tests pass with enhanced format
- [ ] Data aggregator validation succeeds
- [ ] No legacy evaluation format usage in conversation flow

#### Manual Verification:
- [ ] Scenario execution completes without ZodError
- [ ] Evaluation results are properly structured and validated

### Phase 4: Add Comprehensive Testing
**Overview**: Add tests to prevent regression and verify fixes work correctly

#### Changes Required:
1. **Add TrajectoryReconstructor Integration Tests**:
   **File**: `packages/cli/src/commands/scenario/src/__tests__/trajectory-integration.test.ts`
   **Changes**: Create new test file for trajectory reconstruction with real memory scenarios

2. **Add Evaluation Format Tests**:
   **File**: `packages/cli/src/commands/scenario/src/__tests__/evaluation-format.test.ts`
   **Changes**: Create tests to verify evaluation format consistency

3. **Add End-to-End Scenario Tests**:
   **File**: `packages/cli/src/commands/scenario/src/__tests__/dynamic-prompting-e2e.test.ts`
   **Changes**: Create comprehensive E2E tests for dynamic prompting scenarios

#### Success Criteria:
#### Automated Verification:
- [ ] All new tests pass
- [ ] Existing test suite continues to pass
- [ ] Coverage for trajectory reconstruction and evaluation formats

#### Manual Verification:
- [ ] Dynamic prompting scenarios execute successfully
- [ ] Trajectory reconstruction works in real scenarios
- [ ] No ZodError occurs during scenario execution

## Testing Strategy

### Unit Tests:
- **TrajectoryReconstructor**: Test memory type conversion and room ID handling
- **Evaluation System**: Test format consistency and type safety
- **Type Definitions**: Test interface compatibility

### Integration Tests:
- **ConversationManager**: Test complete conversation flow with evaluations
- **Data Aggregator**: Test result validation and trajectory integration
- **Memory System**: Test trajectory reconstruction with real memory data

### Manual Testing Steps:
1. Run basic conversation scenario and verify no ZodError
2. Check trajectory reconstruction produces valid steps
3. Verify evaluation results are properly structured
4. Test room ID mismatch scenarios

## Performance Considerations
- **Memory Queries**: Optimize memory retrieval for trajectory reconstruction
- **Evaluation Processing**: Ensure enhanced evaluations don't significantly impact performance
- **Type Checking**: Minimize runtime type conversion overhead

## Dependencies
- **Internal**: ElizaOS core runtime, memory system, evaluation engine
- **External**: Zod schema validation library
- **Testing**: Bun test framework, existing test infrastructure

## Implementation Log

### Phase 1 - 2025-08-31
- **Changes Made**: Updated type definitions to use `EnhancedEvaluationResult[]` instead of `EvaluationResult[]` throughout the conversation system
- **Files Modified**: 
  - `packages/cli/src/commands/scenario/src/conversation-types.ts` - Updated interfaces and imports
  - `packages/cli/src/commands/scenario/src/ConversationManager.ts` - Fixed evaluation method calls and debug logging
- **Tests Run**: Build completed successfully, ConversationManager tests run without type errors
- **Issues Encountered**: None - all changes worked as expected

## References
- **Research Documents**: 
  - `docs/context_engineering/research/2025-08-31_research_trajectory_zoderror_analysis.md`
  - `docs/context_engineering/research/2025-08-31_research_zoderror_evaluations.md`
- **Related Files**: 
  - `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
  - `packages/cli/src/commands/scenario/src/ConversationManager.ts`
  - `packages/cli/src/commands/scenario/src/conversation-types.ts`
  - `packages/cli/src/commands/scenario/src/schema.ts`
- **External Resources**: ElizaOS memory system documentation, Zod validation documentation
