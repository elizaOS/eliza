---
sidebar_position: 2
title: Project System
description: Understanding ElizaOS projects - organizational structure for creating and deploying AI agents
keywords: [projects, organization, configuration, character, agents, deployment]
image: /img/project.jpg
---

# 📝 ElizaOS Projects

Projects are the main organizational structure in ElizaOS, containing all the necessary components to create and deploy AI agents. A project can include one or more agents, each with their own character definition, plugins, and configurations.

## Project Structure

A typical ElizaOS project structure:

```
my-eliza-project/
├── src/
│   └── index.ts        # Main entry point
├── knowledge/          # Knowledge base files
├── package.json        # Dependencies and scripts
└── tsconfig.json       # TypeScript configuration
```

## Creating a New Project

You can create a new ElizaOS project using:

```bash
# Using npm
npm create eliza

# Or using npx
npx @elizaos/cli create
```

The CLI will guide you through the setup process, including:

- Project name
- Database selection (pglite, postgres, etc.)
- Initial configuration

## Project Configuration

The main project file (`src/index.ts`) exports a default project object:

```typescript
import type { Character, IAgentRuntime, Project, ProjectAgent } from '@elizaos/core';
import customPlugin from './plugin';

// Define the character
export const character: Character = {
  name: 'Agent Name',
  plugins: ['@elizaos/plugin-discord', '@elizaos/plugin-direct'],
  // Other character properties
};

// Create a ProjectAgent that includes the character
export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => {
    // Initialize agent-specific functionality
    console.log('Initializing agent:', character.name);
  },
  plugins: [customPlugin],
  tests: [], // Optional tests for your agent
};

// Export the full project with all agents
const project: Project = {
  agents: [projectAgent],
};

export default project;
```

## Character Configuration

Each agent in your project requires a character definition that controls its personality, knowledge, and behavior.

### Required Character Fields

```typescript
{
  name: "agentName", // Character's display name
  plugins: ["@elizaos/plugin-discord"], // Example plugins
  settings: {
    // Configuration settings
    secrets: {}, // API keys and sensitive data
    voice: {}, // Voice configuration
  },
  bio: [], // Character background as a string or array of statements
  style: {
    // Interaction style guide
    all: [], // General style rules
    chat: [], // Chat-specific style
    post: [] // Post-specific style
  }
}
```

### Plugins

Plugins provide your agent with capabilities and integrations:

- `@elizaos/plugin-discord`: Discord integration
- `@elizaos/plugin-telegram`: Telegram integration
- `@elizaos/plugin-twitter`: Twitter/X integration
- `@elizaos/plugin-slack`: Slack integration
- `@elizaos/plugin-direct`: Direct chat interface
- `@elizaos/plugin-simsai`: SimsAI platform integration

View all available plugins: https://github.com/elizaos-plugins/registry

### Settings Configuration

The `settings` object supports various configurations:

```typescript
{
  "settings": {
    "ragKnowledge": false, // Enable RAG knowledge mode
    "voice": {
      "model": "string", // Voice synthesis model
      "url": "string" // Optional voice API URL
    },
    "secrets": {
      // API keys (use env vars in production)
      "API_KEY": "string"
    },
  }
}
```

### Bio & Style

Define your agent's personality and communication style:

```typescript
{
  "bio": ["Expert in blockchain development", "Specializes in DeFi protocols"],
  "style": {
    "all": [
      // Applied to all interactions
      "Keep responses clear",
      "Maintain professional tone"
    ],
    "chat": [
      // Chat-specific style
      "Engage with curiosity",
      "Provide explanations"
    ],
    "post": [
      // Social post style
      "Keep posts informative",
      "Focus on key points"
    ]
  }
}
```

**Style Tips**

- Be specific about tone and mannerisms
- Include platform-specific guidance
- Define clear boundaries and limitations

### Optional Character Fields

```typescript
{
  "username": "handle", // Character's username/handle
  "system": "System prompt text", // Custom system prompt
  "lore": [], // Additional background/history
  "knowledge": [
    // Knowledge base entries
    "Direct string knowledge",
    { "path": "file/path.md", "shared": false },
    { "directory": "knowledge/path", "shared": false }
  ],
  "messageExamples": [], // Example conversations
  "postExamples": [], // Example social posts
  "topics": [], // Areas of expertise
  "adjectives": [] // Character traits
}
```

## Knowledge Management

ElizaOS supports two knowledge modes:

### Classic Mode (Default)

- Direct string knowledge added to character's context
- No chunking or semantic search
- Enabled by default (`settings.ragKnowledge: false`)
- Only processes string knowledge entries
- Simpler but less sophisticated

### RAG Mode

- Advanced knowledge processing with semantic search
- Chunks content and uses embeddings
- Must be explicitly enabled (`settings.ragKnowledge: true`)
- Supports three knowledge types:
  1. Direct string knowledge
  2. Single file references: `{ "path": "path/to/file.md", "shared": false }`
  3. Directory references: `{ "directory": "knowledge/dir", "shared": false }`
- Supported file types: .md, .txt, .pdf
- Optional `shared` flag for knowledge reuse across characters

### Knowledge Path Configuration

- Knowledge files are relative to the project's `knowledge` directory
- Paths should not contain `../` (sanitized for security)
- Both shared and private knowledge supported
- Files automatically reloaded if content changes

## Example Project

Here's a complete example of a project configuration:

```typescript
import type { Character, IAgentRuntime, Project, ProjectAgent } from '@elizaos/core';

export const character: Character = {
  name: 'Tech Helper',
  plugins: ['@elizaos/plugin-discord', '@elizaos/plugin-direct'],
  settings: {
    ragKnowledge: true,
    voice: {
      model: 'en_US-male-medium',
    },
    discord: {
      shouldRespondOnlyToMentions: false,
      allowedChannelIds: ['123456789012345678'],
    },
  },
  bio: ['Friendly technical assistant', 'Specializes in explaining complex topics simply'],
  lore: ['Pioneer in open-source AI development', 'Advocate for AI accessibility'],
  messageExamples: [
    [
      {
        name: 'user1',
        content: { text: 'Can you explain how AI models work?' },
      },
      {
        name: 'TechAI',
        content: {
          text: 'Think of AI models like pattern recognition systems.',
        },
      },
    ],
  ],
  topics: ['artificial intelligence', 'machine learning', 'technology education'],
  knowledge: [
    {
      directory: 'tech_guides',
      shared: true,
    },
  ],
  style: {
    all: ['Clear', 'Patient', 'Educational'],
    chat: ['Interactive', 'Supportive'],
    post: ['Concise', 'Informative'],
  },
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => {
    console.log('Initializing Tech Helper agent');
  },
  plugins: [], // Project-specific plugins
};

const project: Project = {
  agents: [projectAgent],
};

export default project;
```

## Character File Export

While projects are the primary structure in ElizaOS, you can still export standalone character files for compatibility with other systems or sharing character definitions:

```typescript
import fs from 'fs';
import { character } from './src/index';

// Export character to JSON file
fs.writeFileSync('character.json', JSON.stringify(character, null, 2));
```

## Managing Multiple Agents

A project can contain multiple agents, each with its own character and plugins:

```typescript
const project: Project = {
  agents: [
    {
      character: technicalSupportCharacter,
      init: async (runtime) => {
        /* init code */
      },
      plugins: [customSupportPlugin],
    },
    {
      character: communityManagerCharacter,
      init: async (runtime) => {
        /* init code */
      },
      plugins: [communityPlugin],
    },
  ],
};
```

Each agent operates independently but can share the same database and resources.

## Running Your Project

After configuring your project, you can run it using:

```bash
elizaos start
```

This will start your agents according to your project configuration.
