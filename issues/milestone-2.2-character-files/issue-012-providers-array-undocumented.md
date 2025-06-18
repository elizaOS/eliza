# Provider Array Usage in Content Is Undocumented

## 📝 Priority: Medium

## 📋 Issue Summary

Character files and message content can include a `providers` array to specify which context providers should be used for specific messages, but this powerful feature is completely undocumented, leaving users unaware of advanced context management capabilities.

## 🐛 Problem Description

### Undocumented Feature Usage

**Found in actual character files:**
```json
{
  "name": "{{agentName}}",
  "content": {
    "text": "Let me check our guidelines for that.",
    "providers": ["KNOWLEDGE"]
  }
}
```

**Found in action examples:**
```json
{
  "name": "TechAssistant", 
  "content": {
    "text": "Based on recent market data and our knowledge base, here's my analysis...",
    "providers": ["KNOWLEDGE", "TIME", "RECENT_MESSAGES"],
    "actions": ["REPLY"]
  }
}
```

### Where This Feature Is Used But Not Documented

1. **Character Message Examples**: Real character files use providers arrays
2. **Action Implementation**: REPLY action collects providers from message content
3. **Dynamic Context**: Providers can be specified per message for fine-grained control
4. **Template System**: Message templates can include provider specifications

### Missing Documentation Areas

#### **1. Provider Array Purpose**
- What providers arrays do
- How they affect agent responses
- When to use specific providers

#### **2. Available Providers**
- List of built-in providers
- Provider descriptions and purposes
- Plugin-specific providers

#### **3. Usage Patterns**
- Single provider usage
- Multiple provider combinations
- Context-specific provider selection

#### **4. Integration Points**
- How message providers relate to runtime provider system
- Provider precedence and merging
- Dynamic provider selection

## ✅ Acceptance Criteria

- [ ] Provider array usage is fully documented
- [ ] List of available providers with descriptions
- [ ] Usage examples for different scenarios
- [ ] Integration with runtime provider system explained
- [ ] Best practices for provider selection documented
- [ ] Cross-references to provider system documentation

## 🔧 Implementation Steps

### 1. Document Provider Array in Character Files

**Add to `/packages/docs/docs/core/characters.md`:**

```markdown
## Message Content Providers

Message content can specify which providers should be used to supply context for that specific message or response.

### Basic Usage

```json
{
  "name": "{{agentName}}",
  "content": {
    "text": "Let me look that up for you...",
    "providers": ["KNOWLEDGE", "WEB_SEARCH"]
  }
}
```

### Provider Types

| Provider | Description | Use Case |
|----------|-------------|----------|
| `KNOWLEDGE` | Accesses knowledge base and RAG documents | Factual questions, information lookup |
| `TIME` | Provides current date/time information | Time-sensitive responses |
| `RECENT_MESSAGES` | Includes recent conversation context | Conversational continuity |
| `WEB_SEARCH` | Enables web search capabilities | Current information, research |
| `WALLET` | Cryptocurrency wallet information | Financial queries, token balances |
| `GITHUB` | GitHub repository and code information | Development discussions |

### Advanced Usage

#### **Context-Specific Providers**
Different message types can use different provider combinations:

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "What's the current price of Bitcoin?"
        }
      },
      {
        "name": "{{agentName}}",
        "content": {
          "text": "Let me check the latest market data for you...",
          "providers": ["WEB_SEARCH", "TIME"],
          "actions": ["REPLY"]
        }
      }
    ],
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "Tell me about machine learning algorithms"
        }
      },
      {
        "name": "{{agentName}}",
        "content": {
          "text": "Based on our knowledge base, here's an overview of ML algorithms...",
          "providers": ["KNOWLEDGE", "RECENT_MESSAGES"],
          "actions": ["REPLY"]
        }
      }
    ]
  ]
}
```

#### **Dynamic Provider Selection**
Agents can choose providers based on message content:

```json
{
  "name": "{{agentName}}",
  "content": {
    "text": "I'll use the appropriate information sources to answer your question.",
    "providers": ["KNOWLEDGE", "WEB_SEARCH", "TIME"],
    "actions": ["REPLY"]
  }
}
```
```

### 2. Document Provider Integration Patterns

```markdown
## Provider Integration Patterns

### Runtime Provider Merging
When a message specifies providers, they are merged with runtime providers:

```typescript
// Runtime automatically combines:
const allProviders = [
  ...messageProviders,           // From message content
  ...defaultProviders,           // From agent configuration
  'RECENT_MESSAGES'             // Always included
];
```

### Provider Precedence
1. Message-specific providers (highest priority)
2. Response-inherited providers
3. Default agent providers
4. System providers (lowest priority)

### Plugin Providers
Plugins can define custom providers:

```json
{
  "content": {
    "text": "Checking GitHub repository status...",
    "providers": ["GITHUB_REPO", "GITHUB_ISSUES"],
    "actions": ["REPLY"]
  }
}
```
```

### 3. Add Provider Usage to Action Documentation

**Update `/packages/docs/docs/core/actions.md`:**

```markdown
## Provider Integration in Actions

Actions can access providers specified in message content:

```typescript
handler: async (runtime, message, state, options, callback, responses) => {
  // Get providers from message content
  const messageProviders = message.content.providers || [];
  
  // Compose state with message-specific providers
  state = await runtime.composeState(message, [
    ...messageProviders,
    'RECENT_MESSAGES'
  ]);
  
  // Generate response with enhanced context
  const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
    prompt: composePromptFromState({ state, template })
  });
}
```

### Provider-Aware Response Generation

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "What's happening in the crypto market?"
        }
      },
      {
        "name": "{{agentName}}",
        "content": {
          "text": "I'll check the latest market data and news for you.",
          "providers": ["WEB_SEARCH", "TIME", "WALLET"],
          "actions": ["CRYPTO_ANALYSIS"]
        }
      }
    ]
  ]
}
```
```

### 4. Create Provider Reference Guide

**Create `/packages/docs/docs/core/providers-reference.md`:**

```markdown
# Provider Reference Guide

## Built-in Providers

### Core Context Providers

#### **RECENT_MESSAGES**
- **Purpose**: Provides recent conversation history
- **Usage**: Automatically included in most contexts
- **Example**: "As we discussed earlier..."

#### **TIME**  
- **Purpose**: Current date, time, and temporal context
- **Usage**: Time-sensitive responses, scheduling
- **Example**: "It's currently 2:30 PM on Tuesday..."

#### **KNOWLEDGE**
- **Purpose**: Access to knowledge base and RAG documents
- **Usage**: Factual questions, information retrieval
- **Example**: "According to our documentation..."

### Platform Providers

#### **WEB_SEARCH**
- **Purpose**: Real-time web search capabilities
- **Usage**: Current events, research, verification
- **Example**: "I found recent information about..."

#### **GITHUB**
- **Purpose**: GitHub repository and issue information
- **Usage**: Development discussions, code queries
- **Example**: "Looking at the repository structure..."

### Plugin Providers

Providers can be added by plugins for specialized functionality.

## Usage Guidelines

### When to Use Specific Providers

- **KNOWLEDGE**: For questions that can be answered from stored information
- **WEB_SEARCH**: For current events or information not in knowledge base
- **TIME**: For time-sensitive responses or scheduling
- **WALLET**: For cryptocurrency-related queries
- **RECENT_MESSAGES**: For conversational continuity (usually automatic)

### Performance Considerations

- More providers = more context = slower responses
- Choose minimal necessary providers for best performance
- Use specific providers rather than all available providers
```

### 5. Add Examples to Character Documentation

```markdown
## Real-World Provider Examples

### Knowledge-Based Assistant
```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "How do I set up authentication in React?"
        }
      },
      {
        "name": "TechAssistant",
        "content": {
          "text": "Based on our development guides, here are the recommended approaches for React authentication...",
          "providers": ["KNOWLEDGE"],
          "actions": ["REPLY"]
        }
      }
    ]
  ]
}
```

### Market Analysis Bot
```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "What's the market sentiment for SOL today?"
        }
      },
      {
        "name": "CryptoAnalyst",
        "content": {
          "text": "Let me analyze current market data and sentiment for Solana...",
          "providers": ["WEB_SEARCH", "TIME", "WALLET"],
          "actions": ["MARKET_ANALYSIS"]
        }
      }
    ]
  ]
}
```
```

## 📝 Files to Update

### Files to Update
1. `/packages/docs/docs/core/characters.md` - Add provider array documentation
2. `/packages/docs/docs/core/actions.md` - Document provider integration in actions
3. `/packages/docs/docs/core/providers.md` - Cross-reference message provider usage

### New Files to Create
1. `/packages/docs/docs/core/providers-reference.md` - Comprehensive provider guide

### Navigation Updates
1. `/packages/docs/sidebars.ts` - Add provider reference to navigation

## 🧪 Testing

- [ ] Verify all documented providers exist and work
- [ ] Test provider combinations in actual character files
- [ ] Confirm provider integration with action system
- [ ] Validate examples work in real ElizaOS instances
- [ ] Test plugin-specific providers if available

## 📚 Related Issues

- Issue #010: Character format inconsistency (related to content structure)
- Issue #007: Action interface discrepancy (affects provider handling)
- Issue #008: REPLY action example (shows provider usage)

## 💡 Additional Context

### Why Provider Arrays Matter

1. **Fine-Grained Control**: Specify exactly what context each message needs
2. **Performance**: Avoid loading unnecessary providers
3. **Relevance**: Ensure responses use appropriate information sources
4. **Debugging**: Clear visibility into what context influenced responses

### Provider System Architecture

```
Message Content → Providers Array → Runtime Provider System → Context Assembly → LLM Input
```

The provider array in message content is a way to influence this pipeline at the message level.

### Discovery Challenge

This feature is powerful but hidden because:
- No documentation exists
- Examples in codebase don't explain the pattern
- Provider system documentation doesn't mention message-level usage
- Character file documentation doesn't cover advanced features

### Best Practices

1. **Minimal Necessary**: Only include providers that add value for specific messages
2. **Contextual Relevance**: Match providers to message intent
3. **Performance Awareness**: Consider provider cost and latency
4. **Consistency**: Use similar provider patterns for similar message types

## 📎 Source Code References

- Provider usage in actions: `/packages/plugin-bootstrap/src/actions/reply.ts`
- Character examples: `/packages/cli/src/characters/eliza.ts`
- Provider system: `/packages/core/src/runtime.ts`
- Content interface: `/packages/core/src/types/primitives.ts`