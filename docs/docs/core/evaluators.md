---
sidebar_position: 5
---

# 📊 Evaluators

[Evaluators](/api/interfaces/evaluator) are core components that assess and extract information from conversations. They integrate with the [AgentRuntime](/api/classes/AgentRuntime)'s evaluation system.

---

## Overview

Evaluators enable agents to:

- Build long-term memory
- Track goal progress
- Extract facts and insights
- Maintain contextual awareness

---

## Quick Start

1. Import the necessary evaluator types:

```typescript
import { Evaluator, IAgentRuntime, Memory, State } from "@elizaos/core-core";
```

2. Choose or create an evaluator:

```typescript
const evaluator: Evaluator = {
    name: "BASIC_EVALUATOR",
    similes: ["SIMPLE_EVALUATOR"],
    description: "Evaluates basic conversation elements",
    validate: async (runtime: IAgentRuntime, message: Memory) => true,
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        // Evaluation logic here
        return result;
    },
    examples: [],
};
```

---

## Built-in Evaluators

### Fact Evaluator

The fact evaluator extracts and stores factual information from conversations.

```typescript
interface Fact {
    claim: string;
    type: "fact" | "opinion" | "status";
    in_bio: boolean;
    already_known: boolean;
}
```

Source: https://github.com/elizaos/eliza/blob/main/packages/core/src/types.ts

**Example Facts:**

```json
{
    "claim": "User completed marathon training",
    "type": "fact",
    "in_bio": false,
    "already_known": false
}
```

### Goal Evaluator

From bootstrap plugin - tracks conversation goals:

```typescript
interface Goal {
    id: string;
    name: string;
    status: "IN_PROGRESS" | "DONE" | "FAILED";
    objectives: Objective[];
}

interface Objective {
    description: string;
    completed: boolean;
}
```

---

## Best Practices

### Fact Extraction

- Validate facts before storage
- Avoid duplicate entries
- Include relevant context
- Properly categorize information types

### Goal Tracking

- Define clear, measurable objectives
- Update only changed goals
- Handle failures gracefully
- Track partial progress

### Validation

- Keep validation logic efficient
- Check prerequisites first
- Consider message content and state
- Use appropriate memory managers

### Handler Implementation

- Use runtime services appropriately
- Store results in the correct memory manager
- Handle errors gracefully
- Maintain state consistency

### Examples

- Provide clear context descriptions
- Show typical trigger messages
- Document expected outcomes
- Cover edge cases

---

## Creating Custom Evaluators

Implement the Evaluator interface:

```typescript
interface Evaluator {
    name: string;
    similes: string[];
    description: string;
    validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
    handler: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
    ) => Promise<any>;
    examples: EvaluatorExample[];
}
```

Source: https://github.com/elizaos/eliza/blob/main/packages/core/src/types.ts

### Memory Integration

Example of storing evaluator results:

```typescript
try {
    const memory = await runtime.memoryManager.addEmbeddingToMemory({
        userId: user?.id,
        content: { text: evaluationResult },
        roomId: roomId,
        embedding: await embed(runtime, evaluationResult),
    });

    await runtime.memoryManager.createMemory(memory);
} catch (error) {
    console.error("Failed to store evaluation result:", error);
}
```

Source: https://github.com/elizaos/eliza/blob/main/packages/core/__tests__/memory.test.ts

### Memory Usage

Evaluators should use runtime memory managers for storage:

```typescript
const memoryEvaluator: Evaluator = {
    name: "MEMORY_EVAL",
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        // Store in message memory
        await runtime.messageManager.createMemory({
            id: message.id,
            content: message.content,
            roomId: message.roomId,
            userId: message.userId,
            agentId: runtime.agentId,
        });

        // Store in description memory
        await runtime.descriptionManager.createMemory({
            id: message.id,
            content: { text: "User description" },
            roomId: message.roomId,
            userId: message.userId,
            agentId: runtime.agentId,
        });
    },
};
```

---

## Integration with Agent Runtime

The [AgentRuntime](/api/classes/AgentRuntime) processes evaluators through its [evaluate](/api/classes/AgentRuntime#evaluate) method:

```typescript
// Register evaluator
runtime.registerEvaluator(customEvaluator);

// Process evaluations
const results = await runtime.evaluate(message, state);
```

---

## Error Handling

```typescript
const robustEvaluator: Evaluator = {
    name: "ROBUST_EVAL",
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            // Attempt evaluation
            await runtime.messageManager.createMemory({
                id: message.id,
                content: message.content,
                roomId: message.roomId,
                userId: message.userId,
                agentId: runtime.agentId,
            });
        } catch (error) {
            // Log error and handle gracefully
            console.error("Evaluation failed:", error);

            // Store error state if needed
            await runtime.messageManager.createMemory({
                id: message.id,
                content: { text: "Evaluation failed" },
                roomId: message.roomId,
                userId: message.userId,
                agentId: runtime.agentId,
            });
        }
    },
};
```
