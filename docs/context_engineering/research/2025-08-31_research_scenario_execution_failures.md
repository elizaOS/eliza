# Research: Scenario Execution Failures Analysis

**Date**: 2025-08-31 17:50:15 UTC
**Repository**: ElizaOS
**Branch**: dynamic-prompting

## Research Question
Why is the dynamic prompting scenario still failing even though it gets further along in execution, and what are the root causes of the specific errors shown in the logs?

## Key Findings

### 1. **EnhancedEvaluationEngine Missing Conversation Evaluators**
- **Location**: `packages/cli/src/commands/scenario/src/EnhancedEvaluationEngine.ts:40-50`
- **Description**: The `EnhancedEvaluationEngine` only registers 6 evaluator types: `string_contains`, `regex_match`, `file_exists`, `trajectory_contains_action`, `llm_judge`, `execution_time`
- **Significance**: The scenario uses `conversation_length` and `user_satisfaction` evaluators which are NOT registered in the enhanced engine, causing "Unknown evaluator type" errors

### 2. **LLM Judge Runtime Access Issue**
- **Location**: `packages/cli/src/commands/scenario/src/EnhancedEvaluationEngine.ts:358-420`
- **Description**: The `EnhancedLLMJudgeEvaluator` tries to access `(runtime as any).getModel` but the runtime object doesn't have this method available
- **Significance**: This causes the error "undefined is not an object (evaluating 'runtime.getModel')" in the LLM judge evaluator

### 3. **Evaluation Engine Registration Mismatch**
- **Location**: `packages/cli/src/commands/scenario/src/EvaluationEngine.ts:30-45`
- **Description**: The legacy `EvaluationEngine` registers conversation evaluators (`conversation_length`, `user_satisfaction`, etc.) but the `EnhancedEvaluationEngine` does not
- **Significance**: This creates an inconsistency where legacy evaluations work but enhanced evaluations fail for conversation-specific evaluators

### 4. **Scenario Configuration Uses Enhanced Evaluators**
- **Location**: `packages/cli/src/commands/scenario/examples/basic-conversation.scenario.yaml:35-50`
- **Description**: The scenario configuration specifies `conversation_length` and `user_satisfaction` evaluators in `final_evaluations`
- **Significance**: These evaluators are not available in the enhanced evaluation engine, causing failures

### 5. **Runtime Model Access Pattern Inconsistency**
- **Location**: `packages/cli/src/commands/scenario/src/EnhancedEvaluationEngine.ts:375-380`
- **Description**: The enhanced LLM judge uses `(runtime as any).getModel?.(m)` while the legacy version uses `runtime.getModel(modelType)`
- **Significance**: The enhanced version uses optional chaining and type casting, but the runtime object doesn't have the expected structure

## Architecture Insights

### Current Implementation
- **Dual Evaluation System**: The codebase has both legacy (`EvaluationEngine`) and enhanced (`EnhancedEvaluationEngine`) evaluation systems
- **Registration Mismatch**: Legacy engine registers conversation evaluators, enhanced engine does not
- **Runtime Access Patterns**: Different evaluators use different patterns to access runtime models
- **Type Safety Issues**: Heavy use of `(runtime as any)` casting suggests runtime interface inconsistencies

### Data Flow Analysis
1. **Scenario Parsing**: Scenario YAML is parsed correctly
2. **Conversation Execution**: Multi-turn conversation executes successfully (4 turns completed)
3. **Evaluation Phase**: Enhanced evaluation engine is used for final evaluations
4. **Evaluator Lookup**: Enhanced engine cannot find `conversation_length` and `user_satisfaction` evaluators
5. **LLM Judge Failure**: Enhanced LLM judge fails to access runtime models

### Gaps and Opportunities
- **Missing Evaluators**: Enhanced engine needs conversation evaluators
- **Runtime Interface**: Need consistent runtime model access pattern
- **Type Safety**: Reduce reliance on `(runtime as any)` casting
- **Registration Consistency**: Ensure both engines register the same evaluator types

## Root Cause Analysis

### Primary Issue: EnhancedEvaluationEngine Incomplete Registration
The enhanced evaluation engine is missing conversation-specific evaluators that are defined in the scenario configuration. This is a direct result of the enhanced engine not being updated when conversation evaluators were added.

### Secondary Issue: Runtime Model Access
The enhanced LLM judge evaluator uses a different pattern to access runtime models than the legacy version, and this pattern is failing because the runtime object doesn't have the expected structure.

### Tertiary Issue: Type System Inconsistencies
The heavy use of type casting suggests that the runtime interface is not well-defined, leading to runtime errors when accessing methods.

## Recommendations

### Immediate Fixes (Phase 2 Priority)
1. **Add Missing Evaluators to EnhancedEvaluationEngine**: Register `conversation_length`, `user_satisfaction`, `conversation_flow`, and `context_retention` evaluators
2. **Fix Runtime Model Access**: Use consistent pattern for accessing runtime models across all evaluators
3. **Create Enhanced Conversation Evaluators**: Implement enhanced versions of conversation evaluators

### Medium-term Improvements
1. **Standardize Runtime Interface**: Define clear interface for runtime model access
2. **Reduce Type Casting**: Use proper TypeScript types instead of `(runtime as any)`
3. **Synchronize Engine Registration**: Ensure both evaluation engines register the same evaluator types

### Long-term Architecture
1. **Unified Evaluation System**: Consider consolidating legacy and enhanced evaluation systems
2. **Runtime Interface Design**: Design a clear, type-safe interface for runtime model access
3. **Evaluator Registration Pattern**: Create a consistent pattern for registering evaluators across engines

## References
- **Files Analyzed**: 
  - `packages/cli/src/commands/scenario/src/EnhancedEvaluationEngine.ts`
  - `packages/cli/src/commands/scenario/src/EvaluationEngine.ts`
  - `packages/cli/src/commands/scenario/src/ConversationEvaluators.ts`
  - `packages/cli/src/commands/scenario/examples/basic-conversation.scenario.yaml`
  - `packages/cli/packages/cli/src/commands/scenario/_logs_/run-2025-08-31-001-11-06-17-step-0-execution.json`
- **Related Research**: 
  - `docs/context_engineering/research/2025-08-31_research_trajectory_zoderror_analysis.md`
  - `docs/context_engineering/research/2025-08-31_research_zoderror_evaluations.md`
- **External Resources**: ElizaOS evaluation system documentation, TypeScript interface design patterns
