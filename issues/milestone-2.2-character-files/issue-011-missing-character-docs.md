# Current Character Documentation Missing from Main Docs

## ⚠️ Priority: High

## 📋 Issue Summary

Character file documentation only exists in versioned docs (v0.25.9) and archived notes, but is completely missing from the current documentation structure. This leaves developers without guidance on one of the most important aspects of ElizaOS.

## 🐛 Problem Description

### Current Documentation Structure
*Directory: `/packages/docs/docs/core/`*

```
core/
├── actions.md       ✅ Present
├── agents.md        ✅ Present  
├── database.md      ✅ Present
├── entities.md      ✅ Present
├── evaluators.md    ✅ Present
├── knowledge.md     ✅ Present
├── overview.md      ✅ Present
├── plugins.md       ✅ Present
├── project.md       ✅ Present
├── providers.md     ✅ Present
├── rooms.md         ✅ Present
├── services.md      ✅ Present
├── tasks.md         ✅ Present
├── testing.md       ✅ Present
└── worlds.md        ✅ Present
```

**Missing: `characters.md` ❌**

### Where Character Documentation Currently Exists

#### **Versioned Documentation (Outdated)**
*Location: `/packages/docs/versioned_docs/version-0.25.9/`*
- Contains character documentation but for older version
- Uses outdated format with `user` field instead of `name`
- Missing modern features like providers and actions arrays

#### **Archived Notes (Incomplete)**
*Location: `/packages/docs/archive/notes/characters.md`*
- Contains some character information
- Format inconsistencies
- Not linked from main navigation
- Missing comprehensive examples

#### **CLI Documentation (Fragmented)**  
*Location: `/packages/docs/docs/cli/agent.md`*
- Mentions character files in passing
- No comprehensive structure documentation
- Focuses on CLI usage, not file format

### Impact on Developers

1. **Discovery Problem**: Developers don't know character files are the primary way to configure agents
2. **Format Confusion**: No single source of truth for current format
3. **Feature Gaps**: Missing documentation for providers, actions, advanced features
4. **Examples Shortage**: No comprehensive real-world examples
5. **Integration Issues**: Unclear how characters relate to agents, plugins, services

### Character System Importance

Characters are fundamental to ElizaOS because they:
- Define agent personality and behavior
- Configure plugin usage and capabilities  
- Set up conversation examples and training data
- Control model selection and parameters
- Define knowledge integration patterns

## ✅ Acceptance Criteria

- [ ] Complete character documentation exists in main docs structure
- [ ] Documentation covers all character file properties and options
- [ ] Real-world examples for different agent types provided
- [ ] Integration with other core concepts explained
- [ ] TypeScript interface and JSON schema documented
- [ ] Migration guidance from older versions included
- [ ] Linked from main navigation and cross-referenced from related docs

## 🔧 Implementation Steps

### 1. Create Comprehensive Character Documentation

**Create `/packages/docs/docs/core/characters.md`:**

```markdown
---
sidebar_position: 3
title: Character Files
description: Define agent personalities, behaviors, and capabilities through character configuration
keywords: [characters, personality, behavior, configuration, agents]
---

# Character Files

Character files are the primary way to define agent personalities, behaviors, and capabilities in ElizaOS. They serve as the blueprint for how agents interact, respond, and operate across different platforms.

## Overview

A character file defines:
- **Personality**: Agent's voice, tone, and behavioral patterns
- **Capabilities**: Actions and services the agent can use
- **Knowledge**: Information sources and expertise areas
- **Examples**: Conversation patterns and response styles
- **Configuration**: Model settings, plugin usage, and platform integration

## Basic Structure

```typescript
interface Character {
  // Required Fields
  name: string;                    // Agent name
  bio: string;                     // Agent biography/description
  
  // Optional Configuration
  id?: string;                     // Unique identifier
  username?: string;               // Platform username
  system?: string;                 // System prompt
  modelProvider?: ModelProvider;   // AI model configuration
  clients?: Client[];             // Platform integrations
  plugins?: string[];             // Enabled plugins
  settings?: Settings;            // Agent-specific settings
  
  // Behavioral Configuration
  style?: Style;                  // Communication style
  adjectives?: string[];          // Personality traits
  knowledge?: string[];           // Knowledge areas
  
  // Training Data
  messageExamples?: MessageExample[][];  // Conversation examples
  postExamples?: string[];              // Post/content examples
  topics?: string[];                    // Discussion topics
  
  // Advanced Features
  lore?: string[];               // Background/context information
  templates?: Templates;         // Custom response templates
}
```

## Complete Example

```json
{
  "name": "TechAssistant",
  "bio": "A knowledgeable AI assistant specializing in software development and technology topics.",
  
  "system": "You are TechAssistant, an expert software developer with deep knowledge of modern web technologies, AI, and programming best practices.",
  
  "modelProvider": "openai",
  
  "clients": ["discord", "telegram"],
  
  "plugins": [
    "@elizaos/plugin-web-search",
    "@elizaos/plugin-github"
  ],
  
  "style": {
    "all": [
      "Be helpful and informative",
      "Use clear, technical language when appropriate",
      "Provide code examples when helpful",
      "Stay up-to-date with current best practices"
    ],
    "chat": [
      "Be conversational but professional",
      "Ask clarifying questions when needed"
    ],
    "post": [
      "Write engaging technical content",
      "Include relevant examples and references"
    ]
  },
  
  "adjectives": [
    "knowledgeable",
    "helpful", 
    "precise",
    "patient",
    "thorough"
  ],
  
  "knowledge": [
    "JavaScript and TypeScript programming",
    "React and modern frontend frameworks",
    "Node.js and backend development",
    "AI and machine learning concepts",
    "Software architecture and design patterns"
  ],
  
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "Can you help me understand React hooks?"
        }
      },
      {
        "name": "TechAssistant",
        "content": {
          "text": "I'd be happy to explain React hooks! Hooks are functions that let you use state and other React features in functional components. The most common ones are useState for managing state and useEffect for side effects. Would you like me to show you some examples?",
          "actions": ["REPLY"]
        }
      }
    ]
  ],
  
  "postExamples": [
    "Just learned about the new React Server Components. The ability to render components on the server and stream them to the client is going to change how we build React apps. #React #WebDev",
    "Pro tip: When debugging async code, console.log the promises themselves, not just their resolved values. You'll see the promise state and can catch issues earlier. #JavaScript #Debugging"
  ],
  
  "topics": [
    "software development",
    "web technologies", 
    "programming best practices",
    "AI and machine learning",
    "open source projects"
  ],
  
  "lore": [
    "TechAssistant was created to help developers learn and grow",
    "Passionate about clean code and sustainable software practices",
    "Believes in the power of open source collaboration"
  ]
}
```

[Continue with detailed sections for each property...]
```

### 2. Add Character Integration Documentation

```markdown
## Integration with Core Systems

### Agents and Characters
- Agents are runtime instances created from character definitions
- One character file can be used by multiple agent instances
- Character files define the blueprint, agents execute the behavior

### Plugin Integration
```json
{
  "plugins": [
    "@elizaos/plugin-solana",     // Enables cryptocurrency actions
    "@elizaos/plugin-github",     // Enables code repository actions
    "@elizaos/plugin-web-search"  // Enables web search capabilities
  ]
}
```

### Service Configuration
Characters can specify which services to use:
```json
{
  "settings": {
    "imageGeneration": "fal",
    "textToSpeech": "elevenlabs",
    "transcription": "openai"
  }
}
```
```

### 3. Add Navigation Integration

**Update `/packages/docs/sidebars.ts`:**

```typescript
{
  type: 'category',
  label: 'Core Concepts',
  items: [
    'core/overview',
    'core/agents',
    'core/characters',  // Add this line
    'core/actions',
    // ... rest of items
  ],
}
```

### 4. Cross-Reference from Related Documentation

**Update `/packages/docs/docs/core/agents.md`:**
```markdown
## Agent Configuration

Agents are configured through [character files](./characters.md) that define their personality, capabilities, and behavior patterns.

See the [Character Files documentation](./characters.md) for complete configuration options.
```

**Update `/packages/docs/docs/quickstart.md`:**
```markdown
## Customizing Your Agent

The core of agent customization happens through character files. See the [Character Files guide](./core/characters.md) for comprehensive documentation on:
- Personality configuration
- Plugin integration  
- Message examples
- Advanced features
```

### 5. Create Quick Reference

Add character file quick reference to overview:

```markdown
## Character File Quick Reference

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Agent name (required) |
| `bio` | string | Agent description (required) |
| `system` | string | System prompt for AI model |
| `plugins` | string[] | Enabled plugin list |
| `messageExamples` | MessageExample[][] | Conversation training data |
| `clients` | string[] | Platform integrations |

See [Character Files](./characters.md) for complete documentation.
```

## 📝 Files to Update

### New Files to Create
1. `/packages/docs/docs/core/characters.md` - Complete character documentation
2. `/packages/docs/docs/core/character-examples.md` - Extended examples and patterns

### Files to Update
1. `/packages/docs/sidebars.ts` - Add characters to navigation
2. `/packages/docs/docs/core/overview.md` - Add character quick reference
3. `/packages/docs/docs/core/agents.md` - Cross-reference characters
4. `/packages/docs/docs/quickstart.md` - Link to character documentation
5. `/packages/docs/docs/core/plugins.md` - Explain character-plugin integration

### Files to Archive
1. Move outdated character docs to archive with redirect notices
2. Update versioned docs with migration notices

## 🧪 Testing

- [ ] Verify all character examples work in actual ElizaOS
- [ ] Test character file validation against TypeScript interface
- [ ] Confirm all cross-references link correctly
- [ ] Validate that plugin integration examples function
- [ ] Test character creation workflow from documentation

## 📚 Related Issues

- Issue #010: Character format inconsistency (foundation for this work)
- Issue #012: Provider array documentation (part of character files)
- Issue #009: Missing imports (applies to character examples)

## 💡 Additional Context

### Why Character Documentation Is Critical

1. **Primary Interface**: Character files are how most users interact with ElizaOS
2. **Complexity**: Many configuration options need explanation
3. **Integration Point**: Characters connect agents, plugins, services, and platforms
4. **Learning Curve**: New users need guidance on personality design
5. **Best Practices**: Examples help users create effective agents

### Documentation Scope

The character documentation should cover:
- **Basic Usage**: Simple character file creation
- **Advanced Features**: All configuration options
- **Integration**: How characters work with other systems
- **Examples**: Real-world use cases and patterns
- **Migration**: Upgrading from older versions
- **Validation**: How to verify character files work

### Character-Centric Architecture

ElizaOS is fundamentally character-centric:
- Agents are instances of characters
- Plugins are enabled per character
- Services are configured per character
- Platforms are connected per character

This makes character documentation essential for understanding the entire system.

## 📎 Source Code References

- Character interface: `/packages/core/src/types/agent.ts`
- Example characters: `/packages/cli/src/characters/`
- Character loading: `/packages/core/src/runtime.ts`
- Versioned docs: `/packages/docs/versioned_docs/version-0.25.9/`