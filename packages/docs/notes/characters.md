---
sidebar_position: 4
---

# 📝 Character Guide

Character files are JSON-formatted configurations that define an AI character's personality, knowledge, and behavior patterns. This guide explains how to create effective character files for use with Eliza agents.

---

## Overview

A `characterfile` implements the [Character](/api/type-aliases/character) type and defines the character's:

- Core identity and behavior
- Model provider configuration
- Client settings and capabilities
- Interaction examples and style guidelines

**Example:**

```json
{
    "name": "trump",
    "clients": ["discord", "direct"],
    "settings": {
        "voice": { "model": "en_US-male-medium" }
    },
    "bio": [
        "Built a strong economy and reduced inflation.",
        "Promises to make America the crypto capital and restore affordability."
    ],
    "lore": [
        "Secret Service allocations used for election interference.",
        "Promotes WorldLibertyFi for crypto leadership."
    ],
    "knowledge": [
        "Understands border issues, Secret Service dynamics, and financial impacts on families."
    ],
    "messageExamples": [
        {
            "user": "{{user1}}",
            "content": { "text": "What about the border crisis?" },
            "response": "Current administration lets in violent criminals. I secured the border; they destroyed it."
        }
    ],
    "postExamples": [
        "End inflation and make America affordable again.",
        "America needs law and order, not crime creation."
    ]
}
```

---

## Core Components

```json
{
    "id": "unique-identifier",
    "name": "character_name",
    "modelProvider": "ModelProviderName",
    "clients": ["Client1", "Client2"],
    "settings": {
        "secrets": { "key": "value" },
        "voice": { "model": "VoiceModelName", "url": "VoiceModelURL" },
        "model": "CharacterModel",
        "embeddingModel": "EmbeddingModelName"
    },
    "bio": "Character biography or description",
    "lore": [
        "Storyline or backstory element 1",
        "Storyline or backstory element 2"
    ],
    "messageExamples": [["Message example 1", "Message example 2"]],
    "postExamples": ["Post example 1", "Post example 2"],
    "topics": ["Topic1", "Topic2"],
    "adjectives": ["Adjective1", "Adjective2"],
    "style": {
        "all": ["All style guidelines"],
        "chat": ["Chat-specific style guidelines"],
        "post": ["Post-specific style guidelines"]
    }
}
```

### Key Fields

#### `name` (required)

The character's display name for identification and in conversations.

#### `modelProvider` (required)

Specifies the AI model provider. Supported options from [ModelProviderName](/api/enumerations/modelprovidername) include `anthropic`, `llama_local`, `openai`, `livepeer`, and others.

#### `clients` (required)

Array of supported client types from [Clients](/api/enumerations/clients) e.g., `discord`, `direct`, `twitter`, `telegram`, `farcaster`.

#### `bio`

Character background as a string or array of statements.

- Contains biographical information about the character
- Can be a single comprehensive biography or multiple shorter statements
- Multiple statements are randomized to create variety in responses

Example:

```json
"bio": [
  "Mark Andreessen is an American entrepreneur and investor",
  "Co-founder of Netscape and Andreessen Horowitz",
  "Pioneer of the early web, created NCSA Mosaic"
]
```

#### `lore`

Backstory elements and unique character traits. These help define personality and can be randomly sampled in conversations.

Example:

```json
"lore": [
  "Believes strongly in the power of software to transform industries",
  "Known for saying 'Software is eating the world'",
  "Early investor in Facebook, Twitter, and other tech giants"
]
```

#### `knowledge`

Array used for Retrieval Augmented Generation (RAG), containing facts or references to ground the character's responses.

- Can contain chunks of text from articles, books, or other sources
- Helps ground the character's responses in factual information
- Knowledge can be generated from PDFs or other documents using provided tools

#### `messageExamples`

Sample conversations for establishing interaction patterns, help establish the character's conversational style.

```json
"messageExamples": [
  [
    {"user": "user1", "content": {"text": "What's your view on AI?"}},
    {"user": "character", "content": {"text": "AI is transforming every industry..."}}
  ]
]
```

#### `postExamples`

Sample social media posts to guide content style:

```json
"postExamples": [
  "No tax on tips, overtime, or social security for seniors!",
  "End inflation and make America affordable again."
]
```

### Style Configuration

Contains three key sections:

1. `all`: General style instructions for all interactions
2. `chat`: Specific instructions for chat interactions
3. `post`: Specific instructions for social media posts

Each section can contain multiple instructions that guide the character's communication style.

The `style` object defines behavior patterns across contexts:

```json
"style": {
  "all": ["maintain technical accuracy", "be approachable and clear"],
  "chat": ["ask clarifying questions", "provide examples when helpful"],
  "post": ["share insights concisely", "focus on practical applications"]
}
```

### Topics Array

- List of subjects the character is interested in or knowledgeable about
- Used to guide conversations and generate relevant content
- Helps maintain character consistency

### Adjectives Array

- Words that describe the character's traits and personality
- Used for generating responses with a consistent tone
- Can be used in "Mad Libs" style content generation

### Settings Configuration

The `settings` object defines additional configurations like secrets and voice models.

```json
"settings": {
  "secrets": { "API_KEY": "your-api-key" },
  "voice": { "model": "voice-model-id", "url": "voice-service-url" },
  "model": "specific-model-name",
  "embeddingModel": "embedding-model-name"
}
```

### Templates Configuration

The `templates` object defines customizable prompt templates used for various tasks and interactions. Below is the list of available templates:

- `goalsTemplate`
- `factsTemplate`
- `messageHandlerTemplate`
- `shouldRespondTemplate`
- `continueMessageHandlerTemplate`
- `evaluationTemplate`
- `twitterSearchTemplate`
- `twitterPostTemplate`
- `twitterMessageHandlerTemplate`
- `twitterShouldRespondTemplate`
- `telegramMessageHandlerTemplate`
- `telegramShouldRespondTemplate`
- `discordVoiceHandlerTemplate`
- `discordShouldRespondTemplate`
- `discordMessageHandlerTemplate`

### Example: Twitter Post Template

Here’s an example of a `twitterPostTemplate`:

```js
templates: {
    twitterPostTemplate: `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a 1-3 sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements.`,
}
```

---

## Example: Complete Character File

```json
{
    "name": "TechAI",
    "modelProvider": "anthropic",
    "clients": ["discord", "direct"],
    "bio": "AI researcher and educator focused on practical applications",
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
    "style": {
        "all": [
            "explain complex topics simply",
            "be encouraging and supportive"
        ],
        "chat": ["use relevant examples", "check understanding"],
        "post": ["focus on practical insights", "encourage learning"]
    },
    "adjectives": ["knowledgeable", "approachable", "practical"],
    "settings": {
        "model": "claude-3-opus-20240229",
        "voice": { "model": "en-US-neural" }
    }
}
```

---

## Best Practices

1. **Randomization for Variety**

- Break bio and lore into smaller chunks
- This creates more natural, varied responses
- Prevents repetitive or predictable behavior

2. **Knowledge Management**

Use the provided tools to convert documents into knowledge:

- [folder2knowledge](https://github.com/elizaos/characterfile/blob/main/scripts/folder2knowledge.js)
- [knowledge2character](https://github.com/elizaos/characterfile/blob/main/scripts/knowledge2character.js)
- [tweets2character](https://github.com/elizaos/characterfile/blob/main/scripts/tweets2character.js)

Example:

```bash
npx folder2knowledge <path/to/folder>
npx knowledge2character <character-file> <knowledge-file>
```

3. **Style Instructions**

- Be specific about communication patterns
- Include both dos and don'ts
- Consider platform-specific behavior (chat vs posts)

4. **Message Examples**

- Include diverse scenarios
- Show character-specific responses
- Demonstrate typical interaction patterns

---

## Tips for Quality

1. **Bio and Lore**

- Mix factual and personality-defining information
- Include both historical and current details
- Break into modular, reusable pieces

2. **Style Instructions**

- Be specific about tone and mannerisms
- Include platform-specific guidance
- Define clear boundaries and limitations

3. **Examples**

- Cover common scenarios
- Show character-specific reactions
- Demonstrate proper tone and style

4. **Knowledge**

- Focus on relevant information
- Organize in digestible chunks
- Update regularly to maintain relevance

---

## Further Reading

- [Agents Documentation](../core/agents)
- [Model Providers](./fine-tuning)
- [Client Integration](../core/clients)
