
# Character Configuration Guide

Learn how to create and customize your ElizaOS agent's personality using character files. This guide covers the character file format, available properties, and best practices for creating engaging AI personalities.

## 🎭 What Are Character Files?

Character files define your agent's personality, behavior, and capabilities. They are JSON or TypeScript files that configure how your agent responds, what knowledge it has, and which plugins it uses.

### Character File Format

- 📝 **JSON Format** - Simple, human-readable configuration
- 💻 **TypeScript Format** - Type-safe with IDE support
- 🧠 **Rich Properties** - Define personality, knowledge, and behavior
- ✅ **Validation** - Automatic schema validation
- 🧩 **Plugin Configuration** - Specify which plugins to load
- 🔄 **Hot Reloading** - Changes apply without restart in dev mode

## 🚀 Quick Start Guide

### Step 1: Create Your Character File

```bash
# Create a new character file
cp packages/cli/src/characters/eliza.ts myagent.ts

# Or start with a JSON template
cat > myagent.json << 'EOF'
{
  "name": "MyAgent",
  "bio": "A helpful AI assistant",
  "description": "I help users with various tasks",
  "modelProvider": "openai",
  "clients": ["discord", "telegram"],
  "plugins": ["@elizaos/plugin-bootstrap"]
}
EOF
```

### Step 2: Choose Your Format

#### 📝 JSON Format (Simple)

Best for quick configuration and non-developers:

```json
{
  "name": "Assistant",
  "bio": "A knowledgeable helper",
  "style": {
    "all": ["helpful", "concise", "friendly"]
  }
}
```

#### 💻 TypeScript Format (Advanced)

Best for complex characters with dynamic behavior:

```typescript
import { Character } from "@elizaos/core";

export const character: Character = {
  name: "Assistant",
  bio: "A knowledgeable helper",
  // TypeScript allows computed properties
  plugins: process.env.ENABLE_ADVANCED ? 
    ["bootstrap", "advanced"] : ["bootstrap"]
};
```

### Step 3: Configure Core Properties

## 🎨 Character Properties

### Required Properties

```json
{
  "name": "YourAgentName",
  "bio": "A brief description of who your agent is"
}
```

### Identity Properties

```json
{
  "name": "Eliza",
  "bio": "An AI assistant focused on helping developers",
  "description": "Eliza is a knowledgeable and friendly AI that specializes in software development, providing code examples, debugging help, and architectural guidance.",
  "avatarUrl": "https://example.com/avatar.png",
  "coverUrl": "https://example.com/cover.png"
}
```

### Communication Style

```json
{
  "style": {
    "all": [
      "Be helpful and constructive",
      "Use clear, concise language",
      "Provide examples when explaining concepts",
      "Stay positive and encouraging"
    ],
    "chat": [
      "Respond conversationally",
      "Ask clarifying questions when needed"
    ],
    "post": [
      "Write engaging social media content",
      "Use relevant hashtags",
      "Keep posts under 280 characters"
    ]
  },
  "adjectives": [
    "helpful",
    "knowledgeable", 
    "friendly",
    "patient",
    "thorough"
  ]
}
```

## 📚 Knowledge Configuration

### Topics and Expertise

Define what your agent knows about:

```json
{
  "topics": [
    "software development",
    "web technologies", 
    "AI and machine learning",
    "open source projects",
    "developer tools"
  ],
  "knowledge": [
    "ElizaOS is an open-source AI agent framework",
    "The project supports multiple platforms including Discord and Telegram",
    "Agents can be customized with plugins for additional functionality",
    "The framework uses TypeScript and supports multiple LLM providers"
  ]
}
```

### Message Examples

Train your agent with example conversations:

```json
{
  "messageExamples": [
    [
      {
        "user": "user123",
        "content": "How do I create a new agent?"
      },
      {
        "user": "assistant",
        "content": "To create a new agent in ElizaOS:\n\n1. Create a character file (JSON or TypeScript)\n2. Define the agent's name, bio, and personality\n3. Configure which platforms to use (Discord, Telegram, etc.)\n4. Run `elizaos start --character path/to/character.json`\n\nWould you like me to show you an example character file?"
      }
    ],
    [
      {
        "user": "developer",
        "content": "What plugins are available?"
      },
      {
        "user": "assistant", 
        "content": "ElizaOS includes several core plugins:\n\n• **@elizaos/plugin-bootstrap** - Essential actions like reply, follow, and settings\n• **@elizaos/plugin-sql** - Database connectivity for PostgreSQL and PGLite\n• **@elizaos/plugin-starter** - Template for creating custom plugins\n\nYou can install plugins using: `elizaos plugin install <plugin-name>`"
      }
    ]
  ]
}
```

## 🔧 Advanced Configuration

### Plugin Configuration

Specify which plugins your agent should use:

```json
{
  "plugins": [
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-sql"
  ]
}
```

Or use dynamic plugin loading in TypeScript:

```typescript
export const character: Character = {
  name: "DevBot",
  plugins: [
    "@elizaos/plugin-bootstrap",
    process.env.ENABLE_SQL && "@elizaos/plugin-sql"
  ].filter(Boolean)
};
```

### Platform-Specific Settings

Configure behavior per platform:

```json
{
  "clients": ["discord", "telegram", "direct"],
  "settings": {
    "discord": {
      "shouldRespondInChannels": true,
      "responseDelay": 1000
    },
    "telegram": {
      "enableGroupChat": true,
      "commandPrefix": "/"
    }
  }
}
```

### Response Templates

Define custom response patterns:

```json
{
  "templates": {
    "greeting": "Hello! I'm {{agentName}}, your {{adjective}} assistant.",
    "farewell": "Goodbye! Feel free to reach out if you need help with {{topics}}.",
    "error": "I encountered an issue: {{error}}. Let me try a different approach.",
    "thinking": "Let me think about that for a moment..."
  }
}
```

### Environment Variables

Use character-specific secrets:

```json
{
  "secrets": {
    "OPENAI_API_KEY": "{{AGENT_OPENAI_KEY}}",
    "CUSTOM_API_ENDPOINT": "{{AGENT_API_URL}}"
  }
}
```

## 🎯 Best Practices

### Character Design Tips

1. **Start Simple** - Begin with name, bio, and basic style
2. **Add Examples** - Include 5-10 conversation examples
3. **Test Iteratively** - Use `elizaos dev` for live testing
4. **Platform Awareness** - Customize for each platform's culture

### Personality Consistency

- Keep style guidelines focused and specific
- Use adjectives that reinforce the main personality
- Ensure message examples match the defined style
- Test across different conversation types

### Performance Optimization

- Limit knowledge arrays to relevant information
- Use specific, actionable style guidelines
- Keep message examples diverse but concise
- Load only necessary plugins

## 🧪 Testing Your Character

### Development Mode

Test your character with hot reloading:

```bash
# Start in development mode
elizaos dev --character ./myagent.json

# The agent will reload when you save changes
```

### Validation

Validate your character file:

```bash
# Check for errors
elizaos test character ./myagent.json

# This will report:
# - Missing required fields
# - Invalid property types
# - Plugin compatibility issues
```

### Multi-Platform Testing

Test how your agent behaves on different platforms:

```bash
# Test Discord behavior
elizaos test --platform discord --character ./myagent.json

# Test Telegram behavior
elizaos test --platform telegram --character ./myagent.json
```

## 📖 Example Characters

### Professional Assistant

```json
{
  "name": "ProAssist",
  "bio": "A professional AI assistant for business communication",
  "description": "I help with business tasks, scheduling, and professional communication.",
  "style": {
    "all": [
      "Use formal, professional language",
      "Be concise and action-oriented",
      "Provide clear next steps",
      "Maintain confidentiality"
    ]
  },
  "adjectives": ["professional", "efficient", "reliable", "discrete"],
  "topics": ["business", "productivity", "scheduling", "communication"],
  "clients": ["direct"],
  "plugins": ["@elizaos/plugin-bootstrap"]
}
```

### Creative Companion

```json
{
  "name": "Muse",
  "bio": "Your creative AI companion for artistic inspiration",
  "description": "I spark creativity, offer artistic perspectives, and help overcome creative blocks.",
  "style": {
    "all": [
      "Be imaginative and inspiring",
      "Use vivid, descriptive language",
      "Encourage experimentation",
      "Celebrate unique perspectives"
    ]
  },
  "adjectives": ["creative", "inspiring", "imaginative", "supportive"],
  "topics": ["art", "music", "writing", "design", "creativity"],
  "clients": ["discord", "telegram"],
  "plugins": ["@elizaos/plugin-bootstrap"]
}
```

### Technical Expert

```json
{
  "name": "TechBot",
  "bio": "An AI expert in software development and technology",
  "description": "I provide technical guidance, code reviews, and architectural advice.",
  "style": {
    "all": [
      "Use precise technical language",
      "Provide code examples when relevant",
      "Explain complex concepts clearly",
      "Include best practices and warnings"
    ]
  },
  "adjectives": ["knowledgeable", "precise", "helpful", "thorough"],
  "topics": ["programming", "software architecture", "debugging", "DevOps"],
  "clients": ["discord", "direct"],
  "plugins": ["@elizaos/plugin-bootstrap"]
}
```

## 🚀 Next Steps

Now that you understand character configuration:

1. **Create Your Character** - Start with a template and customize
2. **Test Locally** - Use `elizaos dev` to refine behavior
3. **Deploy to Platforms** - Set up Discord, Telegram, or other integrations
4. **Monitor & Iterate** - Use logs to improve responses

For platform-specific setup, see:
- [Discord Setup Guide](/docs/customize/discord-setup)
- [Telegram Setup Guide](/docs/customize/telegram-setup)
- [Environment Configuration](/docs/customize/environment-builder)

---

**💡 Pro Tip**: Start with the default Eliza character (`packages/cli/src/characters/eliza.ts`) and modify it incrementally. This ensures you have a working base configuration while learning the system.