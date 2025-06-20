---
sidebar_position: 6
title: Actions System
description: Learn about ElizaOS actions - the core components that define agent capabilities and responses
keywords: [actions, responses, handlers, validation, examples, reply, implementation]
image: /img/actions.jpg
---

# ⚡ Actions

Actions define how agents respond to and interact with messages. They enable agents to perform tasks beyond simple message responses by integrating with external systems and modifying behavior.

## Overview

Actions are core components that define an agent's capabilities and how it can respond to conversations. Each action represents a distinct operation that an agent can perform, ranging from simple replies to complex interactions with external systems.

1. Structure:

An Action consists of:

- `name`: Unique identifier
- `similes`: Alternative names/triggers
- `description`: Purpose and usage explanation
- `validate`: Function to check if action is appropriate
- `handler`: Core implementation logic
- `examples`: Sample usage patterns
- `suppressInitialMessage`: Optional flag to suppress initial response

2. Agent Decision Flow:

When a message is received:

- The agent evaluates all available actions using their validation functions
- Valid actions are provided to the LLM via the `actionsProvider`
- The LLM decides which action(s) to execute
- Each action's handler generates a response including a "thought" component (agent's internal reasoning)
- The response is processed and sent back to the conversation

3. Integration:

Actions work in concert with:

- **Providers** - Supply context before the agent decides what action to take
- **Evaluators** - Process conversations after actions to extract insights and update memory
- **Services** - Enable actions to interact with external systems

---

## Implementation

The core `Action` interface and its related types define the structure for all actions in ElizaOS.

> **Source Reference**: The `Action` interface and its supporting types are defined in [`packages/core/src/types/components.ts`](https://github.com/elizaos/eliza/blob/main/packages/core/src/types/components.ts).

### The Action Interface

```typescript
// Source: packages/core/src/types/components.ts
import {
  Action,
  Handler,
  Validator,
  ActionExample,
  IAgentRuntime,
  Memory,
  State,
  Content,
  HandlerCallback,
} from '@elizaos/core';

/**
 * Represents an action the agent can perform.
 */
export interface Action {
  /** A unique, descriptive name for the action. */
  name: string;

  /** A detailed description of what the action does and when it should be used. */
  description: string;

  /** The function that executes the action's logic. */
  handler: Handler;

  /** A function that quickly determines if the action is valid for the current context. */
  validate: Validator;

  /** (Optional) Alternative names or trigger phrases for the action. */
  similes?: string[];

  /** (Optional) A list of examples demonstrating how the action is used. */
  examples?: ActionExample[][];
}
```

### Supporting Type Definitions

- **`Handler`**: The function that contains the core logic of the action.
  ```typescript
  // Source: packages/core/src/types/components.ts
  export type Handler = (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
    responses?: Memory[]
  ) => Promise<unknown>;
  ```
- **`Validator`**: A lightweight function that checks if an action is applicable to the current message. It should execute quickly.
  ```typescript
  // Source: packages/core/src/types/components.ts
  export type Validator = (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => Promise<boolean>;
  ```
- **`HandlerCallback`**: A function passed to the handler to send a response back to the user.
  ```typescript
  // Source: packages/core/src/types/components.ts
  export type HandlerCallback = (response: Content, files?: any) => Promise<Memory[]>;
  ```
- **`ActionExample`**: Defines the structure for providing examples of the action's usage.
  ```typescript
  // Source: packages/core/src/types/components.ts
  interface ActionExample {
    name: string;
    content: Content;
  }
  ```

### Basic Action Template

Here is a complete and up-to-date template for creating a custom action.

```typescript
import { Action, IAgentRuntime, Memory, State, HandlerCallback, Content } from '@elizaos/core';

const customAction: Action = {
  name: 'CUSTOM_ACTION',
  description: 'Detailed description of when and how to use this action.',

  // Optional fields for better agent performance
  similes: ['ALTERNATE_NAME', 'OTHER_TRIGGER'],
  examples: [
    [
      {
        name: '{{name1}}', // A variable representing the user's name
        content: { text: 'A message that would trigger this action.' },
      },
      {
        name: '{{name2}}', // A variable representing the agent's name
        content: {
          text: 'An example of the text response from the agent.',
          thought: 'An example of the internal thought process of the agent.',
          actions: ['CUSTOM_ACTION'], // The action being performed
        },
      },
    ],
  ],

  // The validation function, runs quickly to check if the action is relevant
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Add logic here to determine if this action applies to the current message.
    // For example, check for keywords in message.content.text
    return message.content.text.toLowerCase().includes('custom keyword');
  },

  // The handler function, contains the core logic of the action
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<unknown> => {
    // This is where the main logic for your action goes.
    // You can interact with services, APIs, or the database here.

    const responseContent: Content = {
      thought: "The user mentioned 'custom keyword', so I am executing CUSTOM_ACTION.",
      text: 'I have successfully executed the custom action.',
      actions: ['CUSTOM_ACTION'],
    };

    // Use the callback to send the response to the user
    if (callback) {
      await callback(responseContent);
    }

    // You can also return data that might be used by other parts of the system.
    return { success: true };
  },
};

export default customAction;
```

### Character File Example

Actions can be referenced in character files to define how an agent should respond to specific types of messages:

```json
"messageExamples": [
    [
        {
            "name": "{{user1}}",
            "content": {
                "text": "Can you help transfer some SOL?"
            }
        },
        {
            "name": "SBF",
            "content": {
                "text": "yeah yeah for sure, sending SOL is pretty straightforward. just need the recipient and amount. everything else is basically fine, trust me.",
                "actions": ["SEND_SOL"]
            }
        }
    ]
]
```

### The Reply Action

The `REPLY` action is the most fundamental action, allowing agents to respond with text. It serves as the default action when no specialized behavior is needed. The implementation below showcases several important patterns used in ElizaOS.

> **Source Reference**: The complete implementation is in [`packages/plugin-bootstrap/src/actions/reply.ts`](https://github.com/elizaos/eliza/blob/main/packages/plugin-bootstrap/src/actions/reply.ts).

```typescript
import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ModelType,
  composePromptFromState,
  parseJSONObjectFromText,
  Content,
} from '@elizaos/core';
// Note: replyTemplate would be imported from a local file in a real plugin.
import { replyTemplate } from '../templates/reply';

const replyAction: Action = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description:
    'Replies to the current conversation with text. This is the default action for standard conversation.',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    // The REPLY action is always considered valid as a fallback.
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<unknown> => {
    try {
      // 1. Collect providers from all available sources to build a comprehensive context.
      const allProviders = [
        ...new Set([
          ...(message.content.providers ?? []),
          ...(responses?.flatMap((response) => response.content.providers ?? []) ?? []),
          'RECENT_MESSAGES', // Always include recent messages for context.
        ]),
      ];

      // 2. Compose the state with the collected providers.
      state = await runtime.composeState(message, allProviders);

      // 3. Use a structured model type for reliable JSON output.
      const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt: composePromptFromState({
          state,
          template: replyTemplate,
        }),
      });

      // 4. Parse the JSON response from the model.
      const responseContentObj = parseJSONObjectFromText(response);

      const responseContent: Content = {
        thought: responseContentObj.thought,
        text: responseContentObj.message || '',
        actions: ['REPLY'],
      };

      // 5. Send the response back to the user via the callback.
      if (callback) {
        await callback(responseContent);
      }

      return { success: true };
    } catch (error) {
      console.error('Error in reply action handler:', error);

      // 6. Provide a fallback response in case of an error.
      if (callback) {
        await callback({
          text: "I'm having a little trouble formulating a response right now. Please try again in a moment.",
          actions: ['REPLY'],
        });
      }

      return { success: false, error: 'Failed to generate model response.' };
    }
  },

  examples: [
    // ... examples would be included here ...
  ],
};

export default replyAction;
```

#### Implementation Deep Dive

The `REPLY` action demonstrates several best practices for creating robust actions:

- **Comprehensive Context**: It gathers context from multiple sources (`message`, previous `responses`) using a `Set` to ensure no duplicate providers are requested. This gives the Language Model the richest possible context to formulate a reply.
- **Structured Model Usage**: It uses `ModelType.OBJECT_LARGE` instead of a simple text model. This forces the LLM to return a predictable JSON structure containing both a `thought` and a `message`, which is more reliable than trying to parse a plain text response.
- **Robust Error Handling**: The entire handler logic is wrapped in a `try...catch` block. If the model fails or the response is invalid, it logs the error and sends a user-friendly fallback message instead of crashing.
- **State Composition**: It uses `runtime.composeState` to build the final state object that gets passed to the prompt, ensuring all necessary data is fetched and formatted correctly.

---

## Actions Provider Integration

The actions provider is responsible for making valid actions available to the agent's reasoning process. When a message is received:

1. The provider validates all available actions against the current message
2. It formats the valid actions for inclusion in the agent context
3. This formatted information is used by the agent to decide which action(s) to take

```typescript
const actionsProvider: Provider = {
  name: 'ACTIONS',
  description: 'Possible response actions',
  position: -1, // High priority provider
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Validate all actions for this message
    const actionPromises = runtime.actions.map(async (action: Action) => {
      const result = await action.validate(runtime, message, state);
      return result ? action : null;
    });

    const resolvedActions = await Promise.all(actionPromises);
    const actionsData = resolvedActions.filter(Boolean);

    // Format action information for the agent
    const values = {
      actionNames: `Possible response actions: ${formatActionNames(actionsData)}`,
      actions: formatActions(actionsData),
      actionExamples: composeActionExamples(actionsData, 10),
    };

    // Return data, values, and text representation
    return {
      data: { actionsData },
      values,
      text: [values.actionNames, values.actionExamples, values.actions]
        .filter(Boolean)
        .join('\n\n'),
    };
  },
};
```

## Example Implementations

ElizaOS includes a wide variety of predefined actions across various plugins in the ecosystem. Here are some key categories:

### Communication Actions

- **REPLY**: Standard text response
- **CONTINUE**: Extend the conversation
- **IGNORE**: End the conversation or ignore irrelevant messages

### Blockchain and Token Actions

- **SEND_TOKEN**: Transfer cryptocurrency
- **CREATE_TOKEN**: Create a new token on a blockchain
- **READ_CONTRACT/WRITE_CONTRACT**: Interact with smart contracts

### Media and Content Generation

- **GENERATE_IMAGE**: Create images from text descriptions
- **SEND_GIF**: Share animated content
- **GENERATE_3D**: Create 3D content

### AI and Agent Management

- **LAUNCH_AGENT**: Create and start a new agent
- **START_SESSION**: Begin an interactive session
- **GENERATE_MEME**: Create humorous content

### Example Image Generation Action

Here's a more detailed example of an image generation action:

```typescript
import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ServiceType,
  generateId,
} from '@elizaos/core';

const generateImageAction: Action = {
  name: 'GENERATE_IMAGE',
  similes: ['CREATE_IMAGE', 'MAKE_IMAGE', 'DRAW'],
  description: "Generates an image based on the user's description",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return (
      text.includes('generate') ||
      text.includes('create') ||
      text.includes('draw') ||
      text.includes('make an image')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      // Get appropriate service
      const imageService = runtime.getService(ServiceType.IMAGE_GENERATION);

      // Generate the response with thought component
      const responseContent = {
        thought:
          "This request is asking for image generation. I'll use the image service to create a visual based on the user's description.",
        text: "I'm generating that image for you now...",
        actions: ['GENERATE_IMAGE'],
      };

      // Send initial response if callback provided
      if (callback) {
        await callback(responseContent);
      }

      // Generate image
      const imageUrl = await imageService.generateImage(message.content.text);

      // Create follow-up message with the generated image
      await runtime.createMemory(
        {
          id: generateId(),
          content: {
            text: "Here's the image I generated:",
            attachments: [
              {
                type: 'image',
                url: imageUrl,
              },
            ],
          },
          agentId: runtime.agentId,
          roomId: message.roomId,
        },
        'messages'
      );

      return true;
    } catch (error) {
      console.error('Image generation failed:', error);

      // Send error response if callback provided
      if (callback) {
        await callback({
          thought: 'The image generation failed due to an error.',
          text: "I'm sorry, I wasn't able to generate that image. There was a technical problem.",
          actions: ['REPLY'],
        });
      }

      return false;
    }
  },

  examples: [
    /* Examples omitted for brevity */
  ],
};
```

## Action-Evaluator-Provider Cycle

Actions are part of a larger cycle in ElizaOS agents:

1. **Providers** fetch relevant context for decision-making
2. **Actions** execute the agent's chosen response
3. **Evaluators** process the conversation to extract insights
4. These insights are stored in memory
5. Future **Providers** can access these insights
6. This informs future **Actions**

For example:

- The FACTS provider retrieves relevant facts about users
- The agent uses this context to decide on an appropriate action
- After the action, the reflection evaluator extracts new facts and relationships
- These are stored in memory and available for future interactions
- This creates a virtuous cycle of continuous learning and improvement

---

## FAQ

### What are Actions in ElizaOS?

Actions are core components that define how agents respond to messages and perform tasks. They encapsulate specific behaviors and capabilities, ranging from simple text replies to complex interactions with external systems.

### How do Actions work?

When a message is received, the agent evaluates all available actions using their validation functions. The agent then decides which action(s) to execute based on the message content and context. Each action's handler generates a response, which may include text, thought processes, and attachments.

### What's the difference between actions and evaluators?

Actions are executed during an agent's response to perform tasks and generate content. Evaluators run after responses to analyze conversations, extract information, and update the agent's memory. Actions are about doing, evaluators are about learning.

### What role do "thoughts" play in actions?

The thought component provides an internal reasoning process for the agent, explaining its decision-making. These thoughts aren't shown to users but help with debugging and understanding the agent's behavior. They're similar to the self-reflection component in evaluators.

### How do I create a custom action?

Define an action object with a name, similes, description, validation function, handler function, and examples. The validation function determines when the action should be used, while the handler contains the implementation logic and generates a response.

### Can actions be chained together?

Yes! Actions can call other actions or services as part of their implementation. This allows for complex workflows that combine multiple capabilities. For example, an action might first reply to a user, then generate an image, and finally store data in a database.

### How does an agent choose which action to use?

The agent uses the following process:

1. All actions are validated against the current message
2. Valid actions are formatted and included in the agent's context
3. The LLM decides which action(s) to execute based on the message and context
4. The chosen action's handler is executed to generate a response

### How do actions integrate with services?

Actions often use services to interact with external systems. The action handler can retrieve a service from the runtime (e.g., `imageService = runtime.getService(ServiceType.IMAGE_GENERATION)`) and then call methods on that service to perform operations.

### What's the difference between `actions` and `action` in responses?

The `actions` array is the modern way to specify multiple actions being performed in a single response. The singular `action` field is maintained for backward compatibility but is deprecated in favor of the array format.

### Can I add custom actions to an existing agent?

Yes! You can create a plugin that defines new actions and then add that plugin to your agent's configuration. This allows you to extend the agent's capabilities without modifying its core implementation.

## Further Reading

- [Evaluators](./evaluators.md)
- [Providers](./providers.md)
- [Services](./services.md)
