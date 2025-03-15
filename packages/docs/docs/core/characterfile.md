# 📝 Character Files

Character files are JSON-formatted configurations that define AI agent personas, combining personality traits, knowledge bases, and interaction patterns to create consistent and effective AI agents. For a full list of capabilities check the `character` type [API docs](/api/type-aliases/character). You can also view and contribute to open sourced example characterfiles here: https://github.com/elizaos/characters.

> For making characters, check out the open source elizagen!: https://elizagen.howieduhzit.best/
> [![](/img/elizagen.png)](/img/elizagen.png)

---

## Required Fields

```json
{
    "name": "character_name",           // Character's display name for identification and in conversations
    "modelProvider": "openai",          // AI model provider (e.g., anthropic, openai, groq, mistral, google)
    "clients": ["discord", "direct"],   // Supported client types
    "plugins": [],                      // Array of plugins to use
    "settings": {                       // Configuration settings
        "ragKnowledge": false,          // Enable RAG for knowledge (default: false)
        "secrets": {},                  // API keys and sensitive data
        "voice": {},                    // Voice configuration
        "model": "string",              // Optional model override
        "modelConfig": {}               // Optional model configuration
    },
    "bio": [],                         // Character background as a string or array of statements
    "style": {                         // Interaction style guide
        "all": [],                     // General style rules
        "chat": [],                    // Chat-specific style
        "post": []                     // Post-specific style
    }
}
```

### modelProvider

Supported providers:  
`openai`, `eternalai`, `anthropic`, `grok`, `groq`, `llama_cloud`, `together`, `llama_local`, `lmstudio`, `google`, `mistral`, `claude_vertex`, `redpill`, `openrouter`, `ollama`, `heurist`, `galadriel`, `falai`, `gaianet`, `ali_bailian`, `volengine`, `nanogpt`, `hyperbolic`, `venice`, `nvidia`, `nineteen_ai`, `akash_chat_api`, `livepeer`, `letzai`, `deepseek`, `infera`, `bedrock`, `atoma`.  

See the full list of models in [api/type-aliases/Models](api/type-aliases/Models/).

### Client Types

Supported client integrations in `clients` array:
- `discord`: Discord bot integration
- `telegram`: Telegram bot  
- `twitter`: Twitter/X bot
- `slack`: Slack integration
- `direct`: Direct chat interface
- `simsai`: SimsAI platform integration

### Plugins

See all the available plugins for Eliza here: https://github.com/elizaos-plugins/registry

### Settings Configuration

The `settings` object supports:
```json
{
    "settings": {
        "ragKnowledge": false,         // Enable RAG knowledge mode
        "voice": {
            "model": "string",         // Voice synthesis model
            "url": "string"           // Optional voice API URL
        },
        "secrets": {                  // API keys (use env vars in production)
            "API_KEY": "string"
        },
        "model": "string",           // Optional model override
        "modelConfig": {             // Optional model parameters
            "temperature": 0.7,
            "maxInputTokens": 4096,
            "maxOutputTokens": 1024,
            "frequency_penalty": 0.0,
            "presence_penalty": 0.0
        },
        "imageSettings": {          // Optional image generation settings
            "steps": 20,
            "width": 1024,
            "height": 1024,
            "cfgScale": 7.5,
            "negativePrompt": "string"
        }
    }
}
```


### Bio & Lore

- Bio = Core identity, character biography
- Lore = Character background lore elements

```json
{
    "bio": [
        "Expert in blockchain development",
        "Specializes in DeFi protocols"
    ],
    "lore": [
        "Created first DeFi protocol in 2020",
        "Helped launch multiple DAOs"
    ]
}
```

**Bio & Lore Tips**
- Mix factual and personality-defining information
- Include both historical and current details
- Break bio and lore into smaller chunks
  - This creates more natural, varied responses
  - Prevents repetitive or predictable behavior

### Style Guidelines
Define interaction patterns:
```json
{
    "style": {
        "all": [                     // Applied to all interactions
            "Keep responses clear",
            "Maintain professional tone"
        ],
        "chat": [                    // Chat-specific style
            "Engage with curiosity",
            "Provide explanations"
        ],
        "post": [                    // Social post style
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



### Optional but Recommended Fields


```json
{
    "username": "handle",              // Character's username/handle
    "system": "System prompt text",    // Custom system prompt
    "lore": [],                       // Additional background/history
    "knowledge": [                     // Knowledge base entries
        "Direct string knowledge",
        { "path": "file/path.md", "shared": false },
        { "directory": "knowledge/path", "shared": false }
    ],
    "messageExamples": [],           // Example conversations
    "postExamples": [],             // Example social posts
    "topics": [],                  // Areas of expertise
    "adjectives": []              // Character traits
}
```

---

#### Topics

- List of subjects the character is interested in or knowledgeable about
- Used to guide conversations and generate relevant content
- Helps maintain character consistency

#### Adjectives

- Words that describe the character's traits and personality
- Used for generating responses with a consistent tone
- Can be used in "Mad Libs" style content generation

---

## Knowledge Management

The character system supports two knowledge modes:

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
- Knowledge files are relative to the `characters/knowledge` directory
- Paths should not contain `../` (sanitized for security)
- Both shared and private knowledge supported
- Files automatically reloaded if content changes

**Knowledge Tips**

- Focus on relevant information
- Organize in digestible chunks
- Update regularly to maintain relevance

Use the provided tools to convert documents into knowledge:

- [folder2knowledge](https://github.com/elizaos/characterfile/blob/main/scripts/folder2knowledge.js)
- [knowledge2character](https://github.com/elizaos/characterfile/blob/main/scripts/knowledge2character.js)
- [tweets2character](https://github.com/elizaos/characterfile/blob/main/scripts/tweets2character.js)

Example:

```bash
npx folder2knowledge <path/to/folder>
npx knowledge2character <character-file> <knowledge-file>
```

---

## Character Definition Components


## Example Character File:

```json
{
    "name": "Tech Helper",
    "modelProvider": "anthropic",
    "clients": ["discord"],
    "plugins": [],
    "settings": {
        "ragKnowledge": true,
        "voice": {
            "model": "en_US-male-medium"
        }
    },
    "bio": [
        "Friendly technical assistant",
        "Specializes in explaining complex topics simply"
    ],
    "lore": [
        "Pioneer in open-source AI development",
        "Advocate for AI accessibility"
    ],
    "messageExamples": [
        [
            {
                "user": "{{user1}}",
                "content": { "text": "Can you explain how AI models work?" }
            },
            {
                "user": "TechAI",
                "content": {
                    "text": "Think of AI models like pattern recognition systems."
                }
            }
        ]
    ],
    "postExamples": [
        "Understanding AI doesn't require a PhD - let's break it down simply",
        "The best AI solutions focus on real human needs"
    ],
    "topics": [
        "artificial intelligence",
        "machine learning",
        "technology education"
    ],
    "knowledge": [
        {
            "directory": "tech_guides",
            "shared": true
        }
    ],
    "adjectives": ["knowledgeable", "approachable", "practical"],
    "style": {
        "all": ["Clear", "Patient", "Educational"],
        "chat": ["Interactive", "Supportive"],
        "post": ["Concise", "Informative"]
    }
}
```




