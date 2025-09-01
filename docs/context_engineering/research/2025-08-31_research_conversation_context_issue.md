# Research: Dynamic Prompting Conversation Context Issue

**Date**: 2025-08-31 18:15:45 UTC
**Repository**: ElizaOS
**Branch**: scenarios-upgrade

## Research Question
Why is the dynamic prompting conversation not progressing and instead asking the same question repeatedly, even though the scenario declares 4 turns and the UserSimulator includes conversation history?

## Key Findings

### 1. **Channel Creation Creates New Context Each Turn**
- **Location**: `packages/cli/src/commands/scenario/src/runtime-factory.ts:330-351`
- **Description**: The `askAgentViaApi` function creates a **new channel** for every single call
- **Significance**: Each turn gets a completely fresh conversation context with no memory of previous turns

### 2. **Agent Has No Access to Previous Conversation History**
- **Location**: `packages/cli/src/commands/scenario/src/ConversationManager.ts:174-180`
- **Description**: Each `executeTurn` calls `askAgentViaApi` with only the current user input, no conversation history
- **Significance**: The agent treats every turn as the first message in a brand new conversation

### 3. **UserSimulator Maintains Context But Agent Doesn't**
- **Location**: `packages/cli/src/commands/scenario/src/UserSimulator.ts:101-111`
- **Description**: UserSimulator correctly includes conversation history in its prompt generation
- **Significance**: The user simulator progresses the conversation, but the agent responds as if it's the first interaction

### 4. **Channel Creation Pattern**
- **Location**: `packages/cli/src/commands/scenario/src/runtime-factory.ts:330-351`
- **Description**: Every `askAgentViaApi` call executes:
  ```typescript
  const channelResponse = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'scenario-test-channel', // Same name but creates new channel
      server_id: defaultServer.id,
      participantCentralUserIds: [testUserId],
      type: ChannelType.GROUP,
      metadata: { scenario: true },
    }),
  });
  ```
- **Significance**: Each POST creates a new channel instance, not reusing existing channels

### 5. **Conversation Flow Analysis**
Based on the logs, the conversation flow is:
1. **Turn 1**: Agent receives "Hi, I need help with something" → Responds helpfully
2. **Turn 2**: UserSimulator generates "Could you help me understand what I should do next?" based on conversation history
3. **Turn 3**: Agent receives same input in **new channel** → Has no memory of Turn 1, responds as if first interaction
4. **Turn 4**: Pattern repeats with new channel and no context

### 6. **Memory Storage vs. Channel Context**
- **Location**: `packages/cli/src/commands/scenario/src/ConversationManager.ts:183-188`
- **Description**: The system attempts to reconstruct trajectory from database logs, but this is separate from agent's conversational memory
- **Significance**: Trajectory reconstruction is for evaluation purposes, not for providing conversation context to the agent

## Architecture Insights

### Current Implementation
- **Channel Management**: Each turn creates a new channel, isolating conversations
- **Context Isolation**: Agent memory is channel-specific, so new channels = no memory
- **UserSimulator Design**: Correctly maintains conversation context across turns
- **Agent Design**: Relies on channel-based memory, which is reset each turn

### Data Flow Analysis
1. **Turn 1**: User input → New Channel A → Agent responds → UserSimulator sees response
2. **Turn 2**: UserSimulator generates input → New Channel B → Agent responds (no memory of Channel A)
3. **Turn 3**: UserSimulator generates input → New Channel C → Agent responds (no memory of Channels A or B)
4. **Turn 4**: Pattern continues with Channel D

### Root Cause
The fundamental issue is that `askAgentViaApi` was designed for **single-turn interactions** where each call is independent. For multi-turn conversations, we need **channel reuse** so the agent maintains conversational memory.

## Gaps and Opportunities

### Missing Implementation
- **Channel Reuse**: No mechanism to reuse the same channel across conversation turns
- **Context Persistence**: Agent doesn't receive conversation history in new channels
- **Memory Continuity**: Agent's memory system is isolated per channel

### Design Mismatch
- **UserSimulator**: Designed for multi-turn conversations with context
- **askAgentViaApi**: Designed for single-turn interactions without context
- **ConversationManager**: Orchestrates multi-turn but doesn't provide context continuity

## Recommendations

### Immediate Fix: Channel Reuse Pattern
1. **Modify ConversationManager**: Create a single channel at the start of the conversation
2. **Update askAgentViaApi**: Add parameter to reuse existing channel instead of creating new ones
3. **Channel Lifecycle**: Create channel once, reuse for all turns, cleanup at end

### Implementation Approach
```typescript
// In ConversationManager.executeConversation()
const { channelId } = await this.createConversationChannel();

// In each executeTurn()
const { response } = await askAgentViaApi(
  this.server,
  this.agentId,
  userInput,
  config.timeout_per_turn_ms,
  this.serverPort,
  channelId // Reuse same channel
);
```

### Alternative Approach: Context Injection
If channel reuse is complex, inject conversation history directly into the agent's prompt:
```typescript
const contextualInput = this.buildContextualInput(userInput, previousTurns);
const { response } = await askAgentViaApi(/* ... */, contextualInput, /* ... */);
```

## References
- **Files Analyzed**: 
  - `packages/cli/src/commands/scenario/src/runtime-factory.ts`
  - `packages/cli/src/commands/scenario/src/ConversationManager.ts`
  - `packages/cli/src/commands/scenario/src/UserSimulator.ts`
  - `packages/cli/src/commands/scenario/examples/basic-conversation.scenario.yaml`
- **Related Research**: 
  - `docs/context_engineering/research/2025-08-31_research_scenario_execution_failures.md`
- **External Resources**: ElizaOS messaging system documentation, channel management patterns
