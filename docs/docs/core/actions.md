---
sidebar_position: 6
---

# ⚡ Actions

Actions are core building blocks in Eliza that define how agents respond to and interact with messages. They allow agents to interact with external systems, modify their behavior, and perform tasks beyond simple message responses.

---

## Overview

Each Action consists of:

- `name`: Unique identifier for the action
- `similes`: Array of alternative names/variations
- `description`: Detailed explanation of the action's purpose
- `validate`: Function that checks if action is appropriate
- `handler`: Implementation of the action's behavior
- `examples`: Array of example usage patterns

---

## Implementation

```typescript
interface Action {
    name: string;
    similes: string[];
    description: string;
    examples: ActionExample[][];
    handler: Handler;
    validate: Validator;
    suppressInitialMessage?: boolean;
}
```

Source: https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts

---

# Built-in Actions

---

## Conversation Flow

### CONTINUE

- Maintains conversation when more context is needed
- Manages natural dialogue progression
- Limited to 3 consecutive continues

### IGNORE

- Gracefully disengages from conversations
- Handles:
    - Inappropriate interactions
    - Natural conversation endings
    - Post-closing responses

### NONE

- Default response action
- Used for standard conversational replies

---

## External Integrations

### TAKE_ORDER

- Records trading/purchase orders
- Processes user conviction levels
- Validates ticker symbols and contract addresses

```typescript
const take_order: Action = {
    name: "TAKE_ORDER",
    similes: ["BUY_ORDER", "PLACE_ORDER"],
    description: "Records a buy order based on the user's conviction level.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = (message.content as Content).text;
        const tickerRegex = /\b[A-Z]{1,5}\b/g;
        return tickerRegex.test(text);
    },
    // ... rest of implementation
};
```

Source: https://github.com/elizaOS/eliza/blob/main/packages/plugin-solana/src/actions/takeOrder.ts

---

## Creating Custom Actions

1. Implement the Action interface
2. Define validation logic
3. Implement handler functionality
4. Provide usage examples

Example:

```typescript
const customAction: Action = {
    name: "CUSTOM_ACTION",
    similes: ["SIMILAR_ACTION"],
    description: "Action purpose",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Validation logic
        return true;
    },
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        // Implementation
    },
    examples: [],
};
```

### Testing Actions

Use the built-in testing framework:

```typescript
test("Validate action behavior", async () => {
    const message: Memory = {
        userId: user.id,
        content: { text: "Test message" },
        roomId,
    };

    const response = await handleMessage(runtime, message);
    // Verify response
});
```

---

## Core Concepts

### Action Structure

```typescript
interface Action {
    name: string;
    similes: string[];
    description: string;
    validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
    handler: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
    ) => Promise<void>;
    examples: ActionExample[][];
    suppressInitialMessage?: boolean;
}
```

### Key Components

- **name**: Unique identifier for the action
- **similes**: Alternative names/triggers for the action
- **description**: Explains when and how the action should be used
- **validate**: Determines if the action can be executed
- **handler**: Implements the action's behavior
- **examples**: Demonstrates proper usage patterns
- **suppressInitialMessage**: When true, suppress the initial response message before processing the action. Useful for actions that generate their own responses (like image generation)

---

## Built-in Actions

### CONTINUE

Continues the conversation when appropriate:

```typescript
const continueAction: Action = {
    name: "CONTINUE",
    similes: ["ELABORATE", "KEEP_TALKING"],
    description:
        "Used when the message requires a follow-up. Don't use it when the conversation is finished.",
    validate: async (runtime, message) => {
        // Validation logic
        return true;
    },
    handler: async (runtime, message, state) => {
        // Continuation logic
    },
};
```

### IGNORE

Stops responding to irrelevant or completed conversations:

```typescript
const ignoreAction: Action = {
    name: "IGNORE",
    similes: ["STOP_TALKING", "STOP_CHATTING"],
    description:
        "Used when ignoring the user is appropriate (conversation ended, user is aggressive, etc.)",
    handler: async (runtime, message) => {
        return true;
    },
};
```

### FOLLOW_ROOM

Actively participates in a conversation:

```typescript
const followRoomAction: Action = {
    name: "FOLLOW_ROOM",
    similes: ["FOLLOW_CHAT", "FOLLOW_CONVERSATION"],
    description:
        "Start following channel with interest, responding without explicit mentions.",
    handler: async (runtime, message) => {
        // Room following logic
    },
};
```

---

## Creating Custom Actions

### Basic Action Template

```typescript
const customAction: Action = {
    name: "CUSTOM_ACTION",
    similes: ["ALTERNATE_NAME", "OTHER_TRIGGER"],
    description: "Detailed description of when and how to use this action",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Validation logic
        return true;
    },
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        // Implementation logic
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Trigger message" },
            },
            {
                user: "{{user2}}",
                content: { text: "Response", action: "CUSTOM_ACTION" },
            },
        ],
    ],
};
```

### Advanced Action Example

```typescript
const complexAction: Action = {
    name: "PROCESS_DOCUMENT",
    similes: ["READ_DOCUMENT", "ANALYZE_DOCUMENT"],
    description: "Process and analyze uploaded documents",
    validate: async (runtime, message) => {
        const hasAttachment = message.content.attachments?.length > 0;
        const supportedTypes = ["pdf", "txt", "doc"];
        return (
            hasAttachment &&
            supportedTypes.includes(message.content.attachments[0].type)
        );
    },
    handler: async (runtime, message, state) => {
        const attachment = message.content.attachments[0];

        // Process document
        const content = await runtime
            .getService<IDocumentService>(ServiceType.DOCUMENT)
            .processDocument(attachment);

        // Store in memory
        await runtime.documentsManager.createMemory({
            id: generateId(),
            content: { text: content },
            userId: message.userId,
            roomId: message.roomId,
        });

        return true;
    },
};
```

---

## Implementation Patterns

### State-Based Actions

```typescript
const stateAction: Action = {
    name: "UPDATE_STATE",
    handler: async (runtime, message, state) => {
        const newState = await runtime.composeState(message, {
            additionalData: "new-data",
        });

        await runtime.updateState(newState);
        return true;
    },
};
```

### Service Integration

```typescript
const serviceAction: Action = {
    name: "TRANSCRIBE_AUDIO",
    handler: async (runtime, message) => {
        const transcriptionService = runtime.getService<ITranscriptionService>(
            ServiceType.TRANSCRIPTION,
        );

        const result = await transcriptionService.transcribe(
            message.content.attachments[0],
        );

        return true;
    },
};
```

---

## Best Practices

### Action Design

1. **Clear Purpose**

    - Single responsibility principle
    - Well-defined triggers
    - Clear success criteria

2. **Robust Validation**

    - Check prerequisites
    - Validate input data
    - Handle edge cases

3. **Error Handling**
    - Graceful failure
    - Meaningful error messages
    - State recovery

### Example Organization

1. **Comprehensive Coverage**

```typescript
examples: [
    // Happy path
    [basicUsageExample],
    // Edge cases
    [edgeCaseExample],
    // Error cases
    [errorCaseExample],
];
```

2. **Clear Context**

```typescript
examples: [
    [
        {
            user: "{{user1}}",
            content: {
                text: "Context message showing why action is needed",
            },
        },
        {
            user: "{{user2}}",
            content: {
                text: "Clear response demonstrating action usage",
                action: "ACTION_NAME",
            },
        },
    ],
];
```

---

## Troubleshooting

### Common Issues

1. **Action Not Triggering**

    - Check validation logic
    - Verify similes list
    - Review example patterns

2. **Handler Failures**

    - Validate service availability
    - Check state requirements
    - Review error logs

3. **State Inconsistencies**
    - Verify state updates
    - Check concurrent modifications
    - Review state transitions

## Advanced Features

### Action Composition

```typescript
const compositeAction: Action = {
    name: "PROCESS_AND_RESPOND",
    handler: async (runtime, message) => {
        // Process first action
        await runtime.processAction("ANALYZE_CONTENT", message);

        // Process second action
        await runtime.processAction("GENERATE_RESPONSE", message);

        return true;
    },
};
```

### Action Chains

```typescript
const chainedAction: Action = {
    name: "WORKFLOW",
    handler: async (runtime, message) => {
        const actions = ["VALIDATE", "PROCESS", "RESPOND"];

        for (const actionName of actions) {
            await runtime.processAction(actionName, message);
        }

        return true;
    },
};
```

---

## Example: Complete Action Implementation

```typescript
import { Action, IAgentRuntime, Memory, State } from "@elizaos/core";

const documentAnalysisAction: Action = {
    name: "ANALYZE_DOCUMENT",
    similes: ["READ_DOCUMENT", "PROCESS_DOCUMENT", "REVIEW_DOCUMENT"],
    description: "Analyzes uploaded documents and provides insights",

    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Check for document attachment
        if (!message.content.attachments?.length) {
            return false;
        }

        // Verify document type
        const attachment = message.content.attachments[0];
        return ["pdf", "txt", "doc"].includes(attachment.type);
    },

    handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        try {
            // Get document service
            const docService = runtime.getService<IDocumentService>(
                ServiceType.DOCUMENT,
            );

            // Process document
            const content = await docService.processDocument(
                message.content.attachments[0],
            );

            // Store analysis
            await runtime.documentsManager.createMemory({
                id: generateId(),
                content: {
                    text: content,
                    analysis: await docService.analyze(content),
                },
                userId: message.userId,
                roomId: message.roomId,
                createdAt: Date.now(),
            });

            return true;
        } catch (error) {
            console.error("Document analysis failed:", error);
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you analyze this document?",
                    attachments: [{ type: "pdf", url: "document.pdf" }],
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze that document for you",
                    action: "ANALYZE_DOCUMENT",
                },
            },
        ],
    ],
};
```

---

# Best Practices

1. **Validation**

    - Thoroughly check input parameters
    - Verify runtime conditions
    - Handle edge cases

2. **Error Handling**

    - Implement comprehensive error catching
    - Provide clear error messages
    - Clean up resources properly

3. **Documentation**
    - Include clear usage examples
    - Document expected inputs/outputs
    - Explain error scenarios

---

## Further Reading

- [Provider System](./providers.md)
- [Service Integration](#)
- [Memory Management](../../packages/core)
