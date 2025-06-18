# Character File Format Inconsistencies Across Documentation

## 🔥 Priority: Critical

## 📋 Issue Summary

Character file documentation shows three different message example formats across different sections, causing confusion about the correct structure. Field names conflict between documentation (`user`) and implementation (`name`).

## 🐛 Problem Description

### Format Inconsistencies Found

#### **Format A: Versioned Documentation**
*File: `/packages/docs/versioned_docs/version-0.25.9/` (multiple files)*

```json
{
  "messageExamples": [
    [
      {
        "user": "{{user1}}",
        "content": { "text": "Can you explain how AI models work?" }
      },
      {
        "user": "TechAI", 
        "content": { "text": "Think of AI models like pattern recognition systems." }
      }
    ]
  ]
}
```

#### **Format B: Archived Documentation**
*File: `/packages/docs/archive/notes/characters.md`*

```json
{
  "messageExamples": [
    {
      "user": "{{user1}}",
      "content": { "text": "What about the border crisis?" },
      "response": "Current administration lets in violent criminals. I secured the border; they destroyed it."
    }
  ]
}
```

#### **Format C: Actual Implementation (TypeScript)**
*File: `/packages/core/src/types/components.ts` and character files*

```typescript
// TypeScript interface
interface MessageExample {
  name: string;          // NOT "user"
  content: Content;
}

// Actual character files use:
{
  "messageExamples": [
    [
      {
        "name": "User",     // Uses "name", not "user"
        "content": {
          "text": "DM them. Sounds like they need to talk about something else."
        }
      },
      {
        "name": "Eliza",
        "content": {
          "text": "I'll send them a private message to discuss this further."
        }
      }
    ]
  ]
}
```

### Additional Format Issues

#### **Provider Array Usage (Undocumented)**
*Found in actual character files but not documented anywhere:*

```json
{
  "content": {
    "text": "Let me check our guidelines.",
    "providers": ["KNOWLEDGE"]  // This usage is not documented
  }
}
```

#### **Actions Array Usage (Inconsistent)**
*Some examples show actions, others don't:*

```json
{
  "content": {
    "text": "I'll send some SOL to that address.",
    "actions": ["SEND_SOL"]  // Sometimes included, sometimes not
  }
}
```

### Field Name Conflicts

| Documentation | Implementation | Impact |
|---------------|----------------|---------|
| `"user": "Name"` | `name: string` | Examples don't work |
| Nested arrays unclear | `MessageExample[][]` | Structure confusion |
| Missing `providers` | Used in real files | Feature not documented |

## ✅ Acceptance Criteria

- [ ] Single consistent format across all documentation
- [ ] Field names match TypeScript interface (`name` not `user`)
- [ ] Provider array usage is documented
- [ ] Actions array usage is explained
- [ ] All examples are valid and compilable
- [ ] Migration guide from old formats provided

## 🔧 Implementation Steps

### 1. Establish Standard Format

**Choose Format C (Implementation-based) as the standard:**

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "User message here",
          "providers": ["KNOWLEDGE"],  // Optional
          "actions": ["REPLY"]         // Optional
        }
      },
      {
        "name": "{{agentName}}",
        "content": {
          "text": "Agent response here",
          "providers": ["TIME", "RECENT_MESSAGES"],  // Optional
          "actions": ["REPLY", "GENERATE_IMAGE"]     // Optional
        }
      }
    ]
  ]
}
```

### 2. Update All Documentation

#### **Create New Character Documentation**
*File: `/packages/docs/docs/core/characters.md`*

```markdown
# Character Files

Character files define agent personalities, behavior patterns, and example interactions.

## Message Examples Format

Message examples train the agent on conversation patterns and response styles.

### Structure

```typescript
interface MessageExample {
  name: string;           // Participant name (user or agent)
  content: Content;       // Message content with optional metadata
}

interface Content {
  text: string;           // Required: Message text
  providers?: string[];   // Optional: Context providers to use
  actions?: string[];     // Optional: Actions performed in response
  attachments?: Attachment[]; // Optional: Media attachments
}
```

### Basic Example

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user1}}",
        "content": {
          "text": "Can you help me understand blockchain technology?"
        }
      },
      {
        "name": "{{agentName}}",
        "content": {
          "text": "I'd be happy to explain blockchain! It's essentially a distributed ledger technology that maintains a continuously growing list of records, called blocks, which are linked and secured using cryptography.",
          "actions": ["REPLY"]
        }
      }
    ]
  ]
}
```

### Advanced Features

#### **Using Providers**
Providers supply context to inform agent responses:

```json
{
  "name": "{{agentName}}",
  "content": {
    "text": "Based on recent market data, here's my analysis...",
    "providers": ["KNOWLEDGE", "TIME", "RECENT_MESSAGES"],
    "actions": ["REPLY"]
  }
}
```

#### **Multiple Actions**
Agents can perform multiple actions in sequence:

```json
{
  "name": "{{agentName}}",
  "content": {
    "text": "I'll generate an image for you and then explain the concept.",
    "actions": ["REPLY", "GENERATE_IMAGE"]
  }
}
```
```

### 3. Fix All Existing Documentation

#### **Update Versioned Docs**
- Replace all `"user"` with `"name"` in version 0.25.9 docs
- Add note about format changes since v0.25.9

#### **Update Archived Docs**
- Fix format in `/packages/docs/archive/notes/characters.md`
- Add deprecation notice for old formats

#### **Update Action Examples**
- Fix character file examples in `/packages/docs/docs/core/actions.md`
- Ensure all examples use consistent format

### 4. Create Migration Guide

```markdown
## Migrating Character Files

### From v0.25.9 Format

```json
// Old format (v0.25.9)
{
  "user": "UserName",
  "content": { "text": "Message" }
}

// New format (v1.0+)
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
```

### 5. Validate Against TypeScript Interface

Ensure documented format exactly matches:

```typescript
// From packages/core/src/types/components.ts
interface MessageExample {
  name: string;
  content: Content;
}

// Message examples are arrays of conversation pairs
messageExamples?: MessageExample[][];
```

## 📝 Files to Update

### New Files to Create
1. `/packages/docs/docs/core/characters.md` - Comprehensive character documentation
2. `/packages/docs/docs/migration/character-file-migration.md` - Migration guide

### Files to Fix
1. `/packages/docs/versioned_docs/version-0.25.9/` - All character examples
2. `/packages/docs/archive/notes/characters.md` - Archived documentation  
3. `/packages/docs/docs/core/actions.md` - Character file examples in actions
4. Any other files with character examples

### Files to Remove/Archive
1. Consider archiving conflicting documentation formats
2. Add redirects from old format documentation

## 🧪 Testing

- [ ] Validate all examples against TypeScript interface
- [ ] Test character files with new format in actual ElizaOS
- [ ] Verify provider and actions arrays work as documented
- [ ] Confirm migration examples work correctly
- [ ] Test that old format fails with helpful error messages

## 📚 Related Issues

- Issue #011: Missing character documentation in main docs
- Issue #012: Provider array usage needs documentation
- Issue #009: Missing imports in character examples

## 💡 Additional Context

### Why This Matters

1. **User Experience**: Inconsistent formats cause setup failures
2. **Migration Issues**: v1 users need clear guidance on changes
3. **Feature Discovery**: Undocumented features (providers, actions) go unused
4. **Support Burden**: Conflicting documentation generates support tickets

### Design Decisions

**Why `name` instead of `user`:**
- More generic (supports agents, users, bots, etc.)
- Matches TypeScript interface
- Aligns with entity system design

**Why nested arrays:**
- Supports multi-turn conversations
- Enables complex interaction patterns
- Matches AI training data formats

**Why optional arrays:**
- Provides flexibility for different use cases
- Allows basic and advanced usage patterns
- Supports progressive feature adoption

### Format Evolution

The character file format has evolved through several versions:
1. **v0.x**: Simple user/response pairs
2. **v0.25.9**: User/content structure  
3. **v1.0**: Name/content with providers and actions

Each version added capabilities but documentation wasn't updated consistently.

## 📎 Source Code References

- TypeScript interface: `/packages/core/src/types/components.ts:9-15`
- Actual character files: `/packages/cli/src/characters/eliza.ts`
- Character type definition: `/packages/core/src/types/agent.ts`
- Current documentation: Various files in `/packages/docs/`