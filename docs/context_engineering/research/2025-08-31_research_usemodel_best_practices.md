# Research: useModel Usage Patterns in Scenario System

**Date**: 2025-08-31 22:05:00 UTC
**Repository**: ElizaOS
**Branch**: dynamic-prompting

## Research Question
How is `useModel` used throughout the scenario system and what are the best practices being followed?

## Key Findings

### 1. **Consistent Parameter Structure**
- **Location**: All scenario components use the same parameter structure
- **Pattern**: `runtime.useModel(ModelType, { messages: [{ role: 'user', content: prompt }], temperature, maxTokens })`
- **Significance**: Consistent API usage across all components

### 2. **Model Type Selection**
- **TEXT_LARGE**: Used for most conversational and analysis tasks
- **OBJECT_SMALL**: Used for structured output generation (evaluations)
- **Pattern**: Appropriate model selection based on task requirements

### 3. **Error Handling Patterns**
- **Location**: `packages/cli/src/commands/scenario/src/UserSimulator.ts:65-85`
- **Pattern**: Try-catch with detailed error logging and fallback responses
- **Significance**: Robust error handling prevents system failures

### 4. **Timeout Handling**
- **Location**: `packages/cli/src/commands/scenario/src/EnhancedEvaluationEngine.ts:419-425`
- **Pattern**: `Promise.race()` with timeout promise
- **Significance**: Prevents hanging on slow LLM responses

## Architecture Insights

### Current Implementation Patterns

#### 1. **UserSimulator Pattern**
```typescript
const response = await this.runtime.useModel(
  ModelType.TEXT_LARGE,
  {
    messages: [{ role: 'user', content: prompt }],
    temperature: this.config.temperature || 0.8,
    maxTokens: this.config.max_tokens || 200,
  }
);
```

**Best Practices Observed:**
- ✅ Uses `messages` format consistently
- ✅ Configurable temperature and maxTokens
- ✅ Comprehensive error handling with fallbacks
- ✅ Detailed logging for debugging

#### 2. **Evaluation Engine Pattern**
```typescript
const response = await Promise.race([
  runtime.useModel(modelType, objectParams),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`LLM judge timeout after ${timeoutMs}ms`)), timeoutMs)
  ),
]);
```

**Best Practices Observed:**
- ✅ Timeout handling with `Promise.race()`
- ✅ Structured output with schema validation
- ✅ Model availability checking before use
- ✅ Graceful degradation on failures

#### 3. **Conversation Evaluators Pattern**
```typescript
const response = await runtime.useModel(
  ModelType.TEXT_LARGE,
  {
    messages: [{ role: 'user', content: analysisPrompt }],
    temperature: 0.1,
  }
);
```

**Best Practices Observed:**
- ✅ Low temperature (0.1) for consistent analysis
- ✅ Clear, focused prompts
- ✅ Simple yes/no response parsing
- ✅ Error handling with default values

### 4. **Enhanced Evaluation Pattern**
```typescript
const objectParams: Omit<ObjectGenerationParams, 'runtime'> = {
  prompt: structuredPrompt,
  schema: jsonSchema,
  temperature,
  output: 'object',
} as any;
```

**Best Practices Observed:**
- ✅ Structured output with JSON schema
- ✅ Object generation parameters
- ✅ Schema validation of responses
- ✅ Detailed error reporting

## Best Practices Summary

### ✅ **Consistently Applied**
1. **Parameter Structure**: All components use the same `{ messages, temperature, maxTokens }` structure
2. **Error Handling**: Comprehensive try-catch blocks with fallback mechanisms
3. **Logging**: Detailed logging for debugging and monitoring
4. **Model Selection**: Appropriate model types for different tasks
5. **Timeout Handling**: Promise.race() pattern for preventing hangs

### ✅ **Configuration Management**
1. **Default Values**: Sensible defaults for temperature, maxTokens
2. **Configurable Parameters**: User-configurable settings via config objects
3. **Environment Awareness**: Model availability checking before use

### ✅ **Response Processing**
1. **Validation**: Schema validation for structured responses
2. **Parsing**: Robust parsing with fallback mechanisms
3. **Cleaning**: Response cleaning to remove meta-commentary
4. **Fallbacks**: Graceful degradation when LLM calls fail

## Issues Identified

### ⚠️ **UserSimulator AI_InvalidPromptError**
- **Location**: `packages/cli/src/commands/scenario/src/UserSimulator.ts:42`
- **Issue**: The LLM is receiving malformed prompt structure
- **Root Cause**: The prompt structure being passed doesn't match expected format
- **Impact**: Falls back to default responses, reducing conversation quality

### ⚠️ **Inconsistent Model Type Usage**
- **Issue**: Some components hardcode `ModelType.TEXT_LARGE` instead of using config
- **Impact**: Less flexibility in model selection
- **Recommendation**: Use configurable model types consistently

## Recommendations

### 1. **Fix UserSimulator Prompt Structure**
```typescript
// Current (problematic)
const response = await this.runtime.useModel(
  ModelType.TEXT_LARGE,
  {
    messages: [{ role: 'user', content: prompt }],
    temperature: this.config.temperature || 0.8,
    maxTokens: this.config.max_tokens || 200,
  }
);

// Recommended - ensure prompt structure is correct
const response = await this.runtime.useModel(
  this.config.model_type || ModelType.TEXT_LARGE,
  {
    messages: [{ role: 'user', content: prompt }],
    temperature: this.config.temperature || 0.8,
    maxTokens: this.config.max_tokens || 200,
  }
);
```

### 2. **Standardize Model Type Configuration**
- Use configurable model types across all components
- Implement model availability checking consistently
- Add model type validation before use

### 3. **Enhance Error Handling**
- Standardize error handling patterns across all components
- Implement retry logic for transient failures
- Add more detailed error categorization

### 4. **Improve Monitoring**
- Add metrics for LLM call success rates
- Implement response time monitoring
- Add structured logging for better debugging

## References
- **Files Analyzed**: 
  - `packages/cli/src/commands/scenario/src/UserSimulator.ts`
  - `packages/cli/src/commands/scenario/src/ConversationEvaluators.ts`
  - `packages/cli/src/commands/scenario/src/EnhancedEvaluationEngine.ts`
  - `packages/cli/src/commands/scenario/src/EvaluationEngine.ts`
  - `packages/cli/src/commands/scenario/src/ConversationManager.ts`
- **Test Files**: Multiple test files showing mock patterns
- **Documentation**: Design documents showing intended patterns

## Conclusion

The scenario system demonstrates good `useModel` usage patterns with consistent parameter structures, comprehensive error handling, and appropriate model selection. The main issue is the UserSimulator prompt structure causing AI_InvalidPromptError, which should be prioritized for fixing. Overall, the system follows best practices for LLM integration in a testing framework.
