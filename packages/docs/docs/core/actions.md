---
sidebar_position: 6
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

The core Action interface includes the following components:

```typescript
interface Action {
  name: string; // Unique identifier
  similes: string[]; // Alternative names/triggers
  description: string; // Purpose and usage explanation
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => Promise<boolean>;
  examples: ActionExample[][];
  suppressInitialMessage?: boolean; // Optional flag
}

// Handler callback for generating responses
type HandlerCallback = (content: Content) => Promise<void>;

// Response content structure
interface Content {
  text: string;
  thought?: string; // Internal reasoning (not shown to users)
  actions?: string[]; // List of action names being performed
  action?: string; // Legacy single action name
  attachments?: Attachment[]; // Optional media attachments
}
```

### Basic Action Template

Here's a simplified template for creating a custom action:

```typescript
const customAction: Action = {
  name: 'CUSTOM_ACTION',
  similes: ['ALTERNATE_NAME', 'OTHER_TRIGGER'],
  description: 'Detailed description of when and how to use this action',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Logic to determine if this action applies to the current message
    // Should be efficient and quick to check
    return true; // Return true if action is valid for this message
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    // Implementation logic - what the action actually does

    // Generate a response with thought and text components
    const responseContent = {
      thought: 'Internal reasoning about what to do (not shown to users)',
      text: 'The actual message to send to the conversation',
      actions: ['CUSTOM_ACTION'], // List of actions being performed
    };

    // Send the response using the callback
    if (callback) {
      await callback(responseContent);
    }

    return true; // Return true if action executed successfully
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: { text: 'Trigger message' },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Response',
          thought: 'Internal reasoning',
          actions: ['CUSTOM_ACTION'],
        },
      },
    ],
  ],
};
```

### Character File Example

Actions can be referenced in character files to define how an agent should respond to specific types of messages:

```json
"messageExamples": [
    [
        {
            "user": "{{user1}}",
            "content": {
                "text": "Can you help transfer some SOL?"
            }
        },
        {
            "user": "SBF",
            "content": {
                "text": "yeah yeah for sure, sending SOL is pretty straightforward. just need the recipient and amount. everything else is basically fine, trust me.",
                "actions": ["SEND_SOL"]
            }
        }
    ]
]
```

### The Reply Action

The most fundamental action is the `REPLY` action, which allows agents to respond to messages with text. It serves as the default action when no specialized behavior is needed:

```typescript
const replyAction: Action = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description: 'Replies to the current conversation with the text from the generated message.',

  validate: async (_runtime: IAgentRuntime) => true, // Always valid

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    // Compose state with necessary providers
    state = await runtime.composeState(message, [
      ...(message.content.providers ?? []),
      'RECENT_MESSAGES',
    ]);

    // Generate response using LLM
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: composePromptFromState({
        state,
        template: replyTemplate,
      }),
    });

    // Parse and format response
    const responseContentObj = parseJSONObjectFromText(response);
    const responseContent = {
      thought: responseContentObj.thought,
      text: responseContentObj.message || '',
      actions: ['REPLY'],
    };

    // Send response via callback
    await callback(responseContent);
    return true;
  },

  examples: [
    /* Examples omitted for brevity */
  ],
};
```

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
const generateImageAction: Action = {
  name: 'GENERATE_IMAGE',
  similes: ['CREATE_IMAGE', 'MAKE_IMAGE', 'DRAW'],
  description: "Generates an image based on the user's description",
  suppressInitialMessage: true, // Don't send initial text response

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
