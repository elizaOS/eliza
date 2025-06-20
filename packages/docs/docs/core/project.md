---
sidebar_position: 2
title: Project System
description: Understanding ElizaOS projects - the organizational structure for creating and deploying AI agents.
keywords: [projects, organization, configuration, character, agents, deployment, structure]
image: /img/project.jpg
---

# �� ElizaOS Projects

When you create a new project using `elizaos create`, it comes with a comprehensive structure designed for modern development, testing, and deployment. This guide provides a detailed breakdown of each part of the project.

## Full Project Layout

```
my-project/
├── src/
│   ├── index.ts          # Main entry point with character definitions
│   └── plugin.ts         # Custom plugin implementation
├── __tests__/            # Comprehensive test suite
│   ├── actions.test.ts   # Action testing
│   ├── character.test.ts # Character validation
│   ├── integration.test.ts # Integration tests
│   └── [additional test files]
├── scripts/
│   └── test-all.sh       # Testing automation scripts
├── cypress/              # End-to-end testing configuration
├── knowledge/            # (Optional) Knowledge files for RAG (create manually)
├── .env.example          # Environment variable template
├── package.json          # Project configuration and dependencies
├── tsconfig.json         # TypeScript configuration
├── tsconfig.build.json   # Build-specific TypeScript config
├── README.md             # Project documentation
├── cypress.config.ts     # E2E testing configuration
├── index.html            # Web interface entry point
├── postcss.config.js     # CSS processing configuration
├── tailwind.config.js    # Tailwind CSS configuration
├── tsup.config.ts        # Build tool configuration
├── vite.config.ts        # Development server configuration
└── vitest.config.ts      # Unit testing configuration
```

## Key Directories and Files Explained

### Source Code (`src/`)

- **`src/index.ts`**: This is the most important file for defining your agent. It's where you configure the agent's character, personality, default model, and the plugins it should use.
- **`src/plugin.ts`**: A starter file for creating your own custom plugin. This is where you can define new actions, providers, or services to extend your agent's capabilities.

### Testing (`__tests__/`, `cypress/`)

ElizaOS projects come with a robust, multi-layered testing setup.

- **`__tests__/`**: This directory contains unit and integration tests for your agent. It uses `vitest`. You can test individual actions, character configurations, and more in isolation.
- **`cypress/`**: For end-to-end (E2E) testing. Cypress tests interact with the running application's UI to simulate real user scenarios.
- **`cypress.config.ts`**, **`vitest.config.ts`**: Configuration files for the respective test frameworks.

### Knowledge (`knowledge/`)

- This directory is **not created by default**. You should create it manually if you want to use Retrieval Augmented Generation (RAG).
- Place your documents (`.pdf`, `.txt`, etc.) in this directory. The agent will automatically ingest them on startup to build its knowledge base, allowing it to answer questions based on their content.

For a complete guide on how to configure and use the knowledge system, see the [Knowledge Management](./knowledge.md) documentation.

```bash
# To use RAG, first create the directory
mkdir knowledge

# Add your documents
cp ~/my-document.pdf knowledge/
```

### Build & Dev Tools

The project template uses a modern toolchain for a great developer experience.

- **`vite.config.ts`**: Configuration for Vite, the high-performance development server that provides features like Hot-Module-Replacement (HMR).
- **`tsup.config.ts`**: Configuration for `tsup`, a fast and simple bundler for TypeScript libraries. Used to build your project for production.
- **`tailwind.config.js`**, **`postcss.config.js`**: Configuration for Tailwind CSS, allowing you to build modern UIs quickly.
- **`tsconfig.json`**, **`tsconfig.build.json`**: TypeScript configuration for development and for production builds.

### Project Configuration

- **`package.json`**: Defines project metadata, dependencies, and scripts (like `dev`, `build`, `test`).
- **`.env.example`**: A template for your environment variables. Copy this to a `.env` file (`cp .env.example .env`) and add your secrets, like API keys. **Never commit your `.env` file to git.**
- **`README.md`**: A pre-populated README for your specific project.
- **`.gitignore`**: A standard list of files and directories to be ignored by git.

## Configuring Your Project

The main project file (`src/index.ts`) exports a default project object that brings together your agents and their characters.

```typescript
import type { Character, IAgentRuntime, Project, ProjectAgent } from '@elizaos/core';
import customPlugin from './plugin';

// Define the character
export const character: Character = {
  name: 'Agent Name',
  plugins: ['@elizaos/plugin-discord', '@elizaos/plugin-direct'],
  // Other character properties...
};

// Create a ProjectAgent that includes the character and any project-specific plugins
export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => {
    // Initialize agent-specific functionality
    console.log('Initializing agent:', character.name);
  },
  plugins: [customPlugin],
  tests: [], // Optional tests for your agent
};

// Export the full project containing all agents
const project: Project = {
  agents: [projectAgent],
};

export default project;
```

For a full breakdown of all the properties available in a Character, see the [Character Files](./characters.md) documentation.

## Running Your Project

After configuring your project, you can run it using the `start` command from your project's root directory:

```bash
elizaos start
```

This will start your agents according to your project configuration.
