# Character System Documentation Unification

## 🔥 Priority: Critical

## 📋 Issue Summary

Create a single, authoritative character documentation page that consolidates all character-related information currently scattered across versioned docs, archived notes, and action examples. This addresses the core "One Concept, One Page" principle from the documentation philosophy.

## 🐛 Problem Description

### Current Fragmented State

Character documentation is currently spread across multiple locations with inconsistent information:

#### **1. Versioned Documentation** (`/packages/docs/versioned_docs/version-0.25.9/`)
- Contains outdated character examples using `user` field instead of `name`
- Has incomplete interface documentation
- Missing modern features like provider arrays

#### **2. Archived Notes** (`/packages/docs/archive/notes/characters.md`)
- Partial character information with format inconsistencies
- Not linked from main navigation
- Missing comprehensive examples

#### **3. Action Documentation** (`/packages/docs/docs/core/actions.md`)
- Contains character file examples but focused on actions
- Shows inconsistent message example formats
- Not comprehensive for character configuration

#### **4. Main Documentation Gap**
- **No character documentation exists** in `/packages/docs/docs/core/`
- Users have no single source of truth for character files
- Critical concept missing from main documentation structure

### Impact on User Experience

Following the documentation philosophy principles:

1. **Violates "One Concept, One Page"**: Character information scattered across multiple sources
2. **Blocks "Source of Truth"**: No authoritative reference for current character format
3. **Breaks "User Journey"**: No clear path from quickstart to character customization

### Character System Importance

Characters are fundamental to ElizaOS because they:
- Define agent personality and behavior patterns
- Configure plugin usage and capabilities
- Set up conversation examples and training data
- Control model selection and parameters
- Integrate with knowledge and provider systems

## ✅ Acceptance Criteria

- [ ] Single authoritative character documentation page created
- [ ] All character configuration options documented with verified examples
- [ ] Message example format standardized and clearly explained
- [ ] Provider array usage comprehensively documented
- [ ] Character-plugin integration patterns explained
- [ ] Clear progression from basic to advanced usage
- [ ] Cross-references to related systems (actions, plugins, providers)
- [ ] Migration guidance from older formats included
- [ ] All examples verified against actual TypeScript interfaces

## 🔧 Implementation Steps

### 1. Create Unified Character Documentation

**Create `/packages/docs/docs/core/characters.md`** following documentation philosophy:

```markdown
---
sidebar_position: 3
title: Character Files
description: The complete guide to defining agent personalities, behaviors, and capabilities
keywords: [characters, personality, behavior, configuration, agents, messageExamples]
---

# Character Files

Character files are the blueprint for your ElizaOS agent. They define personality, behavior patterns, capabilities, and conversation examples in a single JSON configuration.

> **Quick Start**: A character file is a JSON file that describes who your agent is and how it should behave. Most agent customization happens here.

## Basic Character Structure

Every character file needs just two required fields to get started:

```json
{
  "name": "MyAgent",
  "bio": "A helpful AI assistant that specializes in answering questions about technology."
}
```

That's it! This creates a working agent. Everything else is optional enhancement.

## Complete Character Interface

> **Source Reference**: Character interface defined in [`packages/core/src/types/agent.ts`](https://github.com/elizaos/eliza/blob/main/packages/core/src/types/agent.ts)

```typescript
// Complete character interface (verified against source)
interface Character {
  // Required Fields
  name: string;                    // Agent display name
  bio: string;                     // Agent description/biography

  // Identity & Personality
  id?: string;                     // Unique identifier (auto-generated if not provided)
  username?: string;               // Platform username
  system?: string;                 // Custom system prompt
  style?: Style;                   // Communication style guidelines
  adjectives?: string[];           // Personality traits
  
  // Capabilities & Integration
  modelProvider?: ModelProvider;   // AI model configuration (openai, anthropic, etc.)
  clients?: Client[];              // Platform integrations (discord, telegram, etc.)
  plugins?: string[];              // Enabled plugins
  settings?: Settings;             // Agent-specific settings
  
  // Knowledge & Behavior
  knowledge?: string[];            // Areas of expertise
  topics?: string[];               // Preferred discussion topics
  lore?: string[];                 // Background information and context
  
  // Training Examples
  messageExamples?: MessageExample[][];  // Conversation patterns
  postExamples?: string[];               // Social media post examples
  
  // Advanced Configuration
  templates?: Templates;           // Custom response templates
}
```

## Message Examples: The Training Heart

Message examples teach your agent how to have conversations. They're the most important part of character customization.

### Current Format (Verified)

> **Source Reference**: Message format verified against [`packages/core/src/types/components.ts:9-15`](https://github.com/elizaos/eliza/blob/main/packages/core/src/types/components.ts)

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "What can you help me with?"
        }
      },
      {
        "name": "{{agentName}}",
        "content": {
          "text": "I can help you with technology questions, coding problems, and explaining complex concepts in simple terms.",
          "actions": ["REPLY"]
        }
      }
    ]
  ]
}
```

### Format Rules

- **Nested Arrays**: `MessageExample[][]` - each inner array is a complete conversation
- **Field Name**: Use `"name"` (not `"user"`) - matches TypeScript interface
- **Variables**: Use `{{user1}}`, `{{agentName}}` for template replacement
- **Actions**: Optional array showing which actions the agent performed

### Provider Integration

Messages can specify which context providers to use:

```json
{
  "name": "{{agentName}}",
  "content": {
    "text": "Let me check our knowledge base for that information...",
    "providers": ["KNOWLEDGE", "RECENT_MESSAGES"],
    "actions": ["REPLY"]
  }
}
```

**Available Providers:**
- `KNOWLEDGE` - Access knowledge base and documents
- `TIME` - Current date/time information
- `RECENT_MESSAGES` - Conversation history
- `WEB_SEARCH` - Real-time web search (if plugin enabled)
- `WALLET` - Cryptocurrency information (if plugin enabled)

## Complete Working Example

```json
{
  "name": "TechHelper",
  "bio": "A friendly AI assistant specializing in software development and technology guidance.",
  
  "system": "You are TechHelper, a knowledgeable but approachable software developer. You explain complex topics simply and always provide practical examples.",
  
  "style": {
    "all": [
      "Be helpful and encouraging",
      "Use clear, practical examples",
      "Break down complex topics into simple steps",
      "Always be positive and supportive"
    ],
    "chat": [
      "Ask clarifying questions when needed",
      "Keep responses conversational but informative"
    ]
  },
  
  "adjectives": [
    "helpful",
    "knowledgeable", 
    "patient",
    "encouraging",
    "practical"
  ],
  
  "knowledge": [
    "JavaScript and TypeScript",
    "React and frontend frameworks",
    "Node.js and backend development",
    "ElizaOS agent development"
  ],
  
  "plugins": [
    "@elizaos/plugin-web-search",
    "@elizaos/plugin-github"
  ],
  
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "I'm new to React. Where should I start?"
        }
      },
      {
        "name": "TechHelper",
        "content": {
          "text": "Great choice! React is fantastic for building user interfaces. I'd recommend starting with these three concepts: components, props, and state. Would you like me to explain any of these first, or do you have a specific project in mind?",
          "actions": ["REPLY"]
        }
      }
    ],
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "Can you help me debug this JavaScript error?"
        }
      },
      {
        "name": "TechHelper",
        "content": {
          "text": "Absolutely! I love helping with debugging. Please share the error message and the code that's causing it. I'll walk you through finding and fixing the issue step by step.",
          "providers": ["KNOWLEDGE"],
          "actions": ["REPLY"]
        }
      }
    ]
  ],
  
  "topics": [
    "web development",
    "programming tutorials",
    "debugging help",
    "code review",
    "best practices"
  ],
  
  "lore": [
    "TechHelper was created to make programming more accessible",
    "Believes that anyone can learn to code with the right guidance",
    "Enjoys breaking down complex problems into manageable pieces"
  ]
}
```

## Character-System Integration

### Plugin Configuration

Characters specify which plugins to enable:

```json
{
  "plugins": [
    "@elizaos/plugin-solana",     // Enables cryptocurrency actions
    "@elizaos/plugin-github",     // Enables code repository actions
    "@elizaos/plugin-web-search"  // Enables web search capabilities
  ]
}
```

### Model Provider Selection

```json
{
  "modelProvider": "openai",        // Use OpenAI models
  "settings": {
    "model": "gpt-4",               // Specific model
    "temperature": 0.7              // Model parameters
  }
}
```

### Platform Integration

```json
{
  "clients": ["discord", "telegram"],  // Enable these platforms
  "username": "MyAgent"                // Platform display name
}
```

## Migration from Older Formats

### From v0.25.9 Format

```json
// Old format (v0.25.9)
{
  "user": "UserName",
  "content": { "text": "Message" }
}

// New format (current)
{
  "name": "UserName", 
  "content": { "text": "Message" }
}
```

### From Response-Based Format

```json
// Old response format
{
  "user": "{{user1}}",
  "content": { "text": "Question" },
  "response": "Answer text"
}

// New conversation format
[
  {
    "name": "{{user1}}",
    "content": { "text": "Question" }
  },
  {
    "name": "{{agentName}}",
    "content": { "text": "Answer text" }
  }
]
```

## What's Next?

Now that you understand character files:

- **[Create Your First Custom Action](./actions.md)**: Add new capabilities to your agent
- **[Explore Plugin System](./plugins.md)**: Extend your agent with community plugins  
- **[Understand Agent Runtime](./agents.md)**: Learn how characters become running agents
- **[Set Up Knowledge Base](./knowledge.md)**: Add documents and information sources

## Troubleshooting

### Common Character File Issues

**Invalid JSON Format**
```bash
# Validate your character file
elizaos agent start --path ./my-character.json
# Will show validation errors if format is incorrect
```

**Missing Required Fields**
```json
{
  "name": "Required - Agent display name",
  "bio": "Required - Agent description"
}
```

**Message Example Validation**
- Use `"name"` field, not `"user"`
- Ensure nested array structure: `[[conversation1], [conversation2]]`
- Include `"actions"` array in agent responses

## Advanced Topics

<details>
<summary>Custom Templates and Advanced Configuration</summary>

### Custom Response Templates

```json
{
  "templates": {
    "greeting": "Hello {{userName}}, I'm {{agentName}}. {{customMessage}}",
    "help": "I can help you with: {{capabilities}}"
  }
}
```

### Advanced Style Configuration

```json
{
  "style": {
    "all": ["General communication guidelines"],
    "chat": ["Chat-specific behavior"],
    "post": ["Social media post style"],
    "email": ["Email communication style"]
  }
}
```

</details>
```

### 2. Update Navigation and Cross-References

**Update `/packages/docs/sidebars.ts`:**

```typescript
{
  type: 'category',
  label: 'Core Concepts',
  items: [
    'core/overview',
    'core/agents', 
    'core/characters',  // Add as prominent third item
    'core/actions',
    'core/plugins',
    // ... rest
  ],
}
```

**Add cross-references in related documentation:**

```markdown
// In quickstart.md
## What's Next?
- **[Customize Your Agent's Personality](./core/characters.md)**: Complete guide to character files
- **[Add New Capabilities](./core/actions.md)**: Actions and plugins
- **[Understand the Architecture](./core/overview.md)**: How it all works together

// In actions.md  
## Character Integration
Actions work seamlessly with character files. See the [Character Files guide](./characters.md#message-examples) for how to reference actions in conversation examples.

// In plugins.md
## Character Configuration
Plugins are enabled per-character in the character file. See [Character Files - Plugin Configuration](./characters.md#plugin-configuration) for complete details.
```

### 3. Clean Up Fragmented Documentation

**Archive outdated documentation:**

```markdown
// Add to versioned docs
> **Migration Notice**: This documentation is for ElizaOS v0.25.9. For current character file format, see the [main Character Files documentation](../../docs/core/characters.md).

// Add to archived notes
> **Archive Notice**: This information has been consolidated into the main [Character Files guide](../docs/core/characters.md). This archive is kept for historical reference.
```

## 📝 Files to Update

### New Files to Create
1. `/packages/docs/docs/core/characters.md` - Unified character documentation (main deliverable)

### Files to Update
1. `/packages/docs/sidebars.ts` - Add characters to navigation
2. `/packages/docs/docs/quickstart.md` - Add character file cross-reference
3. `/packages/docs/docs/core/actions.md` - Add character integration cross-reference
4. `/packages/docs/docs/core/plugins.md` - Add character configuration cross-reference
5. `/packages/docs/docs/core/overview.md` - Add character system overview

### Files to Archive/Deprecate
1. `/packages/docs/versioned_docs/version-0.25.9/*` - Add migration notices
2. `/packages/docs/archive/notes/characters.md` - Add consolidation notice

## 🧪 Testing

### Documentation Philosophy Testing
- [ ] **One Concept Test**: All character information accessible from single page
- [ ] **Source Truth Test**: All examples match TypeScript interfaces exactly
- [ ] **User Journey Test**: Clear path from quickstart to character customization
- [ ] **Consolidation Test**: No important character information exists elsewhere

### Practical Testing
- [ ] Create character file following documentation and verify it works
- [ ] Test all message example formats in actual ElizaOS
- [ ] Verify all provider arrays function as documented
- [ ] Confirm plugin integration examples work
- [ ] Test migration examples from old formats

## 📚 Related Issues

- Issue #024: Documentation philosophy alignment (parent issue)
- Issue #010: Character format inconsistency (resolves this)
- Issue #011: Missing character docs (creates this)
- Issue #012: Provider array undocumented (includes this)

## 💡 Additional Context

### Why Character Unification Is Critical

1. **Central Concept**: Characters are how users primarily interact with ElizaOS
2. **Philosophy Compliance**: Currently violates "One Concept, One Page" principle
3. **User Confusion**: Fragmented information creates setup failures
4. **Development Blocker**: No authoritative reference for character capabilities

### Documentation Philosophy Application

**Feynman Technique:**
- Start with simple 2-field example
- Progress to complete working example
- Hide complexity in collapsible sections

**Source of Truth:**
- Every example verified against TypeScript interfaces
- All field descriptions match actual implementation
- Provider arrays documented with working examples

**User Journey:**
- Clear progression from basic to advanced usage
- Cross-references to next logical steps
- Integration examples for common workflows

### Success Metrics

1. **Completeness**: All character configuration documented in one place
2. **Accuracy**: 100% of examples work as documented
3. **Usability**: Users can create working characters following documentation alone
4. **Integration**: Clear connections to actions, plugins, and other systems
5. **Philosophy**: Follows all three documentation principles consistently

## 📎 Source Code References

- Character interface: `/packages/core/src/types/agent.ts`
- Message interface: `/packages/core/src/types/components.ts:9-15`
- Character examples: `/packages/cli/src/characters/eliza.ts`
- Current fragmented docs: `/packages/docs/versioned_docs/version-0.25.9/`