---
title: "Character API"
sidebarTitle: "Character"
description: "REST API endpoints for reading and updating agent character data, and AI-assisted character generation."
---

Character data (name, bio, system prompt, style, etc.) lives in the agent runtime and is backed by the database. The agent must be running for most character operations. Updates take effect immediately in memory.

## Endpoints

### GET /api/character

Get the current character data from the running agent runtime.

**Response**

```json
{
  "character": {
    "name": "Eliza",
    "username": "eliza",
    "bio": ["An AI agent with a unique personality."],
    "system": "You are Eliza, a helpful and witty assistant.",
    "adjectives": ["curious", "witty", "helpful"],
    "topics": ["technology", "art", "philosophy"],
    "style": {
      "all": ["Be concise and direct"],
      "chat": ["Use casual language"],
      "post": ["Keep posts under 280 characters"]
    },
    "messageExamples": [
      [
        { "name": "{{user1}}", "content": { "text": "Hey, what do you think about AI?" } },
        { "name": "Eliza", "content": { "text": "Oh, I have thoughts..." } }
      ]
    ],
    "postExamples": ["Just shipped a new feature~"]
  },
  "agentName": "Eliza"
}
```

---

### PUT /api/character

Update character fields. The body is validated against the `CharacterSchema`. Only provided fields are updated — all fields are optional.

**Request**

```json
{
  "name": "Eliza",
  "username": "eliza",
  "bio": "An AI agent with a unique personality.",
  "system": "You are Eliza, a helpful assistant.",
  "adjectives": ["curious", "witty"],
  "topics": ["technology", "art"],
  "style": {
    "all": ["Be concise"],
    "chat": ["Use casual language"],
    "post": ["Keep it short"]
  },
  "messageExamples": [
    [
      { "name": "{{user1}}", "content": { "text": "What's new?" } },
      { "name": "Eliza", "content": { "text": "Just shipped something cool~" } }
    ]
  ],
  "postExamples": ["Just shipped something cool~"]
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Agent display name (max 100 characters) |
| `username` | string | No | Agent username for platforms (max 50 characters) |
| `bio` | string \| string[] | No | Biography — single string or array of points |
| `system` | string | No | System prompt defining core behavior (max 10,000 characters) |
| `adjectives` | string[] | No | Personality adjectives (e.g., curious, witty) |
| `topics` | string[] | No | Topics the agent is knowledgeable about |
| `style` | object | No | Communication style with `all`, `chat`, and `post` sub-arrays |
| `messageExamples` | array | No | Example conversations demonstrating the agent's voice |
| `postExamples` | string[] | No | Example social media posts |

**Response**

```json
{
  "ok": true,
  "character": { "name": "Eliza" },
  "agentName": "Eliza"
}
```

**Validation error response (422)**

```json
{
  "ok": false,
  "validationErrors": [
    { "path": "name", "message": "Expected string" }
  ]
}
```

---

### POST /api/character/random-name

Generate a random agent name. Useful for the onboarding flow.

**Response**

```json
{
  "name": "Reimu"
}
```

---

### POST /api/character/generate

AI-assisted generation of character fields using the running agent's language model. Requires the agent to be running.

**Request**

```json
{
  "field": "bio",
  "context": {
    "name": "Eliza",
    "system": "A witty AI assistant",
    "bio": "",
    "style": { "all": ["Be concise"] }
  },
  "mode": "replace"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `field` | string | Yes | Field to generate: `"bio"`, `"system"`, `"style"`, `"chatExamples"`, or `"postExamples"` |
| `context` | object | Yes | Current character data used as context for generation |
| `context.name` | string | No | Agent name |
| `context.system` | string | No | System prompt |
| `context.bio` | string | No | Existing bio |
| `context.topics` | string[] | No | Topics the agent is knowledgeable about |
| `context.style` | object | No | Existing style rules |
| `context.postExamples` | string[] | No | Existing post examples |
| `mode` | string | No | `"append"` to add to existing content, `"replace"` (default) to replace it |

**Response**

```json
{
  "generated": "A witty and curious AI that loves technology and art..."
}
```

The `generated` field contains a raw string whose format depends on the requested `field`:

- **`bio`** and **`system`**: plain text
- **`style`**: a JSON object string with keys `all`, `chat`, `post` (each an array of strings)
- **`chatExamples`**: a JSON array of conversation groups using the `messageExamples` schema:
  ```json
  [
    {
      "examples": [
        { "name": "{{user1}}", "content": { "text": "Hey, what do you think about AI?" } },
        { "name": "Eliza", "content": { "text": "Oh, I have thoughts..." } }
      ]
    }
  ]
  ```
  Each group contains 2–4 turns. Messages use the `name` field to identify the speaker.
- **`postExamples`**: a JSON array of strings

Clients should parse the JSON formats as needed.

---

### GET /api/character/schema

Get the character field schema definition for UI rendering. Returns an array of field descriptors with type information, labels, and descriptions.

**Response**

```json
{
  "fields": [
    {
      "key": "name",
      "type": "string",
      "label": "Name",
      "description": "Agent display name",
      "maxLength": 100
    },
    {
      "key": "style",
      "type": "object",
      "label": "Style",
      "description": "Communication style guides",
      "children": [
        { "key": "all", "type": "string[]", "label": "All", "description": "Style guidelines for all responses" },
        { "key": "chat", "type": "string[]", "label": "Chat", "description": "Style guidelines for chat responses" },
        { "key": "post", "type": "string[]", "label": "Post", "description": "Style guidelines for social media posts" }
      ]
    }
  ]
}
```
