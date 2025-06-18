---
sidebar_position: 9
title: Character Files
description: Defining agent personalities and behavior with Character files in ElizaOS
keywords: [character, personality, configuration, message examples, providers, actions, RAG]
image: /img/characters.jpg
---

# 🎭 Character Files

Character files are the heart of an agent's personality in ElizaOS. They are JSON or TypeScript files that define everything from the agent's name and backstory to its conversational style and special abilities.

> **Source Reference**: The core `Character` type is defined in [`packages/core/src/types/agent.ts`](https://github.com/elizaos/eliza/blob/main/packages/core/src/types/agent.ts).

## Core Structure

A character file is an object that conforms to the `Character` interface. Here are the most important fields:

```typescript
import { Character } from '@elizaos/core';

export const myCharacter: Character = {
  // The agent's name
  name: "Eliza",
  
  // A custom system prompt to guide the LLM's behavior
  system: "You are a helpful and friendly AI assistant.",
  
  // A list of plugins the agent should use
  plugins: ["@elizaos/plugin-discord", "@elizaos/plugin-openai"],
  
  // Example conversations to train the agent's style
  messageExamples: [
    // ... see Message Examples Format section ...
  ],
  
  // Configuration settings for the agent and its plugins
  settings: {
    // ... see Settings section ...
  }
};
```

## Message Examples Format

`messageExamples` are crucial for training the agent on your desired conversational patterns. They are structured as an array of conversations, where each conversation is an array of messages.

### Structure Definition

```typescript
// From @elizaos/core
interface MessageExample {
  name: string;           // Participant's name (e.g., a user variable or the agent's name)
  content: Content;       // The message content object
}

interface Content {
  text: string;           // Required: The text of the message
  providers?: string[];   // Optional: Context providers to use for this turn
  actions?: string[];     // Optional: A list of actions performed in response
  attachments?: Attachment[]; // Optional: Media attached to the message
}
```

### Basic Example

This example shows a simple two-turn conversation.

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "Can you help me understand what ElizaOS is?"
        }
      },
      {
        "name": "Eliza",
        "content": {
          "text": "Of course! ElizaOS is a framework for building and deploying autonomous AI agents. It lets you create agents with distinct personalities that can interact across multiple platforms.",
          "actions": ["REPLY"]
        }
      }
    ]
  ]
}
```

### Advanced Example: Using Providers and Actions

You can make the agent's responses more dynamic by specifying `providers` and `actions`.

-   `providers`: Inject real-time context (like the current time or specific knowledge) into the agent's brain before it responds.
-   `actions`: Tell the agent which of its capabilities it used to formulate the response.

```json
{
  "name": "Eliza",
  "content": {
    "text": "Based on the latest news, it seems like the market is trending upwards. I've also generated a chart for you.",
    "providers": ["KNOWLEDGE", "NEWS_PROVIDER", "TIME"],
    "actions": ["REPLY", "GENERATE_IMAGE"]
  }
}
```

## Settings and Configuration

The `settings` object allows you to configure the agent's core behavior and the behavior of its plugins.

```json
{
  "settings": {
    // Enable Retrieval-Augmented Generation (RAG)
    "ragKnowledge": true,

    // Configure a specific plugin, like discord
    "discord": {
      "shouldRespondOnlyToMentions": false
    },
    
    // Provide secrets securely
    "secrets": {
      "OPENAI_API_KEY": "your-api-key"
    }
  }
}
```

## Migration Guide for Character Files

The character file format has evolved. If you are coming from an older version, here's how to update your files.

### From v0.25.x (user field)

The most common change is from the `user` field to the `name` field in `messageExamples`.

```json
// OLD format
{
  "user": "UserName",
  "content": { "text": "A message" }
}

// NEW format
{
  "name": "UserName",
  "content": { "text": "A message" }
}
```

### From Flat Response Format

Some very old formats used a flat `response` field. This should be converted to the nested conversation structure.

```json
// OLD format
{
  "user": "{{user1}}",
  "content": { "text": "Question?" },
  "response": "Answer."
}

// NEW format
[
  {
    "name": "{{user1}}",
    "content": { "text": "Question?" }
  },
  {
    "name": "YourAgentName",
    "content": { "text": "Answer." }
  }
]
``` 