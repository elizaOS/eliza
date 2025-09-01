# Research: Trajectory Empty and UserSimulator AI_InvalidPromptError Issues

**Date**: 2025-08-31 21:45:00 UTC
**Repository**: ElizaOS
**Branch**: dynamic-prompting

## Research Question
Why is the trajectory always empty despite having messages, and why is the UserSimulator failing with an AI_InvalidPromptError when the conversation is progressing but falling back to default responses?

## Key Findings

### 1. **Trajectory Empty Issue: Memory Type Mismatch**
- **Location**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts:139-141`
- **Description**: The TrajectoryReconstructor is looking for `action_result` type memories, but the agent is only creating `messages` type memories
- **Significance**: The trajectory system expects action memories that contain structured action data, but the agent creates simple message memories

### 2. **Room ID Mismatch Detection**
- **Location**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts:75-85`
- **Description**: The system detects a mismatch between the expected roomId and the actual roomId where memories are stored
- **Significance**: This causes the reconstructor to look for trajectory data in the wrong location, resulting in 0 steps found

### 3. **UserSimulator AI_InvalidPromptError**
- **Location**: `packages/cli/src/commands/scenario/src/UserSimulator.ts:145-175`
- **Description**: The UserSimulator is generating empty responses from the LLM, causing it to fall back to default responses
- **Significance**: The prompt structure may be causing the LLM to return empty responses, triggering the fallback mechanism

### 4. **Memory Generation Pattern**
- **Location**: `packages/core/src/runtime.ts:744-1009`
- **Description**: The agent runtime creates `action_result` memories when actions are executed, but in conversation scenarios, the agent may not be executing actions
- **Significance**: Conversation scenarios rely on message-based interactions rather than action execution

## Architecture Insights

### Current Implementation
- **Patterns**: The trajectory system expects `action_result` memories with structured action data
- **Integration**: The agent runtime creates both `messages` and `action_result` memories depending on the interaction type
- **Dependencies**: The TrajectoryReconstructor depends on specific memory types that aren't being generated in conversation scenarios

### Gaps and Opportunities
- **Missing**: Support for `messages` type memories in trajectory reconstruction
- **Improvements**: The trajectory system should handle both action-based and message-based interactions
- **Risks**: The current implementation can fail to reconstruct trajectories even when conversations are successful

## Detailed Analysis

### The Trajectory Empty Issue Chain
1. **Memory Type Filter**: TrajectoryReconstructor filters for `action_result` type memories
2. **Agent Behavior**: In conversation scenarios, the agent creates `messages` type memories for responses
3. **Memory Analysis**: The reconstructor finds 0 `action_result` memories, resulting in empty trajectory
4. **Result**: 0 trajectory steps found after 3 retry attempts

### The UserSimulator Issue Chain
1. **Prompt Generation**: UserSimulator builds complex prompts with conversation history
2. **LLM Response**: The LLM returns empty responses, possibly due to prompt structure issues
3. **Fallback Mechanism**: UserSimulator detects empty response and uses fallback
4. **Result**: Conversation progresses but with generic responses instead of persona-driven ones

### Memory Analysis from Logs
The logs show the agent is creating memories with this structure:
```json
{
  "text": "Agent response content",
  "simple": true,
  "actions": ["REPLY"],
  "thought": "Agent's internal reasoning",
  "inReplyTo": "message-id",
  "providers": []
}
```

But the TrajectoryReconstructor expects:
```json
{
  "type": "action_result",
  "actionName": "action_name",
  "actionParams": {},
  "actionResult": {},
  "actionStatus": "completed"
}
```

## Root Cause Analysis

### 1. **Trajectory System Design Mismatch**
The trajectory system was designed for action-based scenarios (like code execution) but is being used for conversation-based scenarios. The fundamental assumption that all interactions generate `action_result` memories is incorrect for conversation flows.

### 2. **UserSimulator Prompt Complexity**
The UserSimulator prompt is very complex with multiple sections, conversation history, and detailed instructions. This complexity may be causing the LLM to return empty responses, possibly due to:
- Token limit issues
- Prompt structure confusion
- Model-specific limitations

### 3. **Memory Type Inconsistency**
The system has two different memory types (`messages` and `action_result`) but the trajectory system only handles one. This creates a fundamental mismatch between what the agent creates and what the trajectory system expects.

## Recommendations

### 1. **Extend TrajectoryReconstructor for Message Memories**
- **Location**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
- **Action**: Add support for `messages` type memories in addition to `action_result` memories
- **Benefit**: Enable trajectory reconstruction for conversation-based scenarios

### 2. **Simplify UserSimulator Prompts**
- **Location**: `packages/cli/src/commands/scenario/src/UserSimulator.ts`
- **Action**: Reduce prompt complexity and add better error handling
- **Benefit**: Improve LLM response reliability and reduce fallback usage

### 3. **Unified Memory Handling**
- **Location**: `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
- **Action**: Create a unified approach to handle both memory types
- **Benefit**: Consistent trajectory reconstruction across all scenario types

## References
- **Files Analyzed**: 
  - `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
  - `packages/cli/src/commands/scenario/src/UserSimulator.ts`
  - `packages/core/src/runtime.ts`
  - `packages/plugin-bootstrap/src/providers/actionState.ts`
- **Related Research**: 
  - `docs/context_engineering/research/2025-08-31_research_trajectory_zoderror_analysis.md`
  - `docs/context_engineering/research/2025-08-31_research_conversation_context_issue.md`
- **External Resources**: ElizaOS memory system documentation
