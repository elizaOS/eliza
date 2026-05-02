---
title: Agent Export & Import
sidebarTitle: Agent Export & Import
description: Export and import Eliza agents as encrypted portable archives for migration between machines.
---

Eliza provides an encrypted export/import system for migrating agents between machines. The entire agent state — character configuration, memories, knowledge, relationships, and more — is captured in a single password-protected binary file.

## Table of Contents

1. [Export](#export)
2. [Character Config in Exports](#character-config-in-exports)
3. [Encryption](#encryption)
4. [Import](#import)
5. [ID Remapping](#id-remapping)
6. [Character File Schema](#character-file-schema)
7. [Export Payload Schema](#export-payload-schema)
8. [Version Compatibility](#version-compatibility)
9. [Sharing Agents](#sharing-agents)
10. [elizaOS Compatibility](#elizaos-compatibility)
11. [API Reference](#api-reference)
12. [Troubleshooting](#troubleshooting)

---

## Export

Exporting creates a `.eliza-agent` file containing a complete snapshot of your agent's state.

### What Is Included

The export payload contains:

| Data Type | Description |
|-----------|-------------|
| **Agent record** | Core agent configuration from the database |
| **Character config** | Full character definition — style, topics, adjectives, message examples, post examples, knowledge sources |
| **Entities** | All entities the agent has interacted with |
| **Memories** | Messages, facts, documents, fragments, descriptions, character modifications, and custom memories |
| **Components** | All components attached to entities |
| **Rooms** | Conversation rooms |
| **Participants** | Room membership records (entity ID, room ID, user state) |
| **Relationships** | Entity-to-entity relationships |
| **Worlds** | World definitions |
| **Tasks** | Scheduled and pending tasks |
| **Logs** (optional) | Execution logs — can be large, disabled by default |

The memory tables queried during export are: `messages`, `facts`, `documents`, `fragments`, `descriptions`, `character_modifications`, and `custom`.

### What Is Excluded

- **Embeddings** — stripped from all memories to reduce file size. They are regenerated on import by the target instance's embedding model.
- **Secrets** — the `secrets` field is removed from the character config before export. Private keys, API tokens, and other credentials are never included in the archive.
- **Plugin binaries** — only plugin references (names) are included, not the actual plugin code.

### How to Export

#### Via the Dashboard

Navigate to **Settings**, expand the **Advanced** section, and find the **Export/Import** area. Enter a password and click Export.

#### Via the API

```
POST /api/agent/export
Content-Type: application/json

{
  "password": "your-password-here",
  "includeLogs": false
}
```

- **password** (required) — must be at least 4 characters.
- **includeLogs** (optional) — set to `true` to include execution logs. Defaults to `false`.

The response is a binary file with:
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="{agentname}-{timestamp}.eliza-agent"`

The filename is derived from the agent's name (lowercased, non-alphanumeric characters replaced with underscores) and an ISO 8601 timestamp. For example: `reimu-2026-02-19T14-30-00.eliza-agent`.

#### Export Size Estimate

Before downloading, you can get an estimate of the export size without creating the full archive:

```
GET /api/agent/export/estimate
```

Returns:

```json
{
  "estimatedBytes": 245000,
  "memoriesCount": 412,
  "entitiesCount": 28,
  "roomsCount": 15,
  "worldsCount": 1,
  "tasksCount": 6
}
```

The byte estimate uses rough per-record sizes: ~500 bytes per memory, ~200 bytes per entity, ~300 per room, ~200 per world, ~400 per task, plus 2,000 bytes of base overhead. Actual file size varies due to compression.

### Data Extraction Process

During export, the service follows a specific order to collect all related data:

1. **Agent record** — fetched from the database by agent ID.
2. **Worlds** — all worlds where `agentId` matches the current agent.
3. **Rooms** — collected from two sources: rooms belonging to the agent's worlds, and rooms where the agent is a participant. Both sets are merged and deduplicated.
4. **Entities and participants** — for each room, all entities and their participant records (including user state: `FOLLOWED` or `MUTED`) are collected.
5. **Components** — for each entity, components are fetched both globally and per-world, then deduplicated by ID.
6. **Memories** — each of the 7 memory table types is queried for the agent's ID, then also queried per-world. All results are deduplicated by memory ID. Embeddings are stripped.
7. **Relationships** — all relationships where the agent is the source entity.
8. **Tasks** — all tasks filtered to the current agent ID.
9. **Logs** (optional) — all execution logs, if `includeLogs` is true.
10. **Runtime character config** — the live character object from the runtime, which may contain fields not persisted to the database (style, topics, adjectives, messageExamples, postExamples, knowledge sources). The `secrets` field is removed.

---

## Character Config in Exports

The export includes a `characterConfig` field separate from the main `agent` record. This exists because the elizaOS runtime character (built by `buildCharacterFromConfig`) may contain fields that are not persisted in the database agent record, such as:

- `style` (communication style rules for all, chat, and post contexts)
- `topics` (knowledge areas)
- `adjectives` (personality descriptors)
- `messageExamples` (example chat conversations)
- `postExamples` (example social media posts)
- `knowledge` (knowledge source references)

On import, the `characterConfig` is merged as the base, with the `agent` record overlaid on top. This ensures the full character definition survives the round-trip even if the database schema does not store all character fields.

---

## Encryption

The export file uses strong encryption to protect your agent data.

### Key Derivation

- **Algorithm:** PBKDF2-SHA256
- **Iterations:** 600,000 (per OWASP 2024 recommendation)
- **Salt:** 32 bytes, randomly generated per export
- **Key length:** 32 bytes (256 bits)

On import, iteration counts up to 1,200,000 (2x the default) are accepted; anything higher is rejected to guard against denial-of-service via excessive iterations.

### Encryption

- **Algorithm:** AES-256-GCM
- **Nonce (IV):** 12 bytes, randomly generated per export
- **Authentication tag:** 16 bytes

### Compression

The JSON payload is compressed with **gzip** before encryption. This typically reduces file size by 60-80% for text-heavy agent data.

### File Format

The `.eliza-agent` file is a binary format:

```
Offset  Size     Field
──────  ───────  ─────────────────────────────────
0       15       Magic header: "ELIZA_AGENT_V1\n"
15      4        PBKDF2 iteration count (uint32 big-endian)
19      32       PBKDF2 salt
51      12       AES-256-GCM nonce (IV)
63      16       AES-GCM authentication tag
79      variable Ciphertext (gzip-compressed JSON, encrypted)
```

Total fixed header size: **79 bytes**.

### Security Properties

- **Password-based:** Only someone with the password can decrypt the archive.
- **Authenticated encryption:** AES-GCM ensures both confidentiality and integrity — tampering with any byte of the file will cause decryption to fail.
- **Unique per-export:** Each export generates a fresh random salt and nonce, so exporting the same agent twice with the same password produces different files.
- **Minimum password length:** 4 characters.
- **Maximum decompressed size:** 16 MiB safety cap on import to prevent decompression bombs. The decompression uses a streaming gunzip with a running byte counter that aborts immediately if the limit is exceeded.
- **No secrets in payload:** The `secrets` field is explicitly deleted from the character config before serialization.

---

## Import

Importing restores an agent from a `.eliza-agent` archive. The import creates a **new agent** in the running instance's database — it does not overwrite the current agent.

### How to Import

#### Via the Dashboard

Navigate to **Settings**, expand the **Advanced** section, and find the **Export/Import** area. Select the `.eliza-agent` file, enter the password used during export, and click Import.

#### Via the API

```
POST /api/agent/import
Content-Type: application/octet-stream
```

The request body uses a binary envelope format:

```
[4 bytes: password length (uint32 big-endian)]
[N bytes: password (UTF-8)]
[remaining bytes: .eliza-agent file data]
```

- **Password:** must be at least 4 characters and at most 1,024 bytes.
- **Maximum request size:** 512 MB.

### Import Processing Steps

The import follows a strict order to satisfy database foreign key constraints:

1. **Decrypt and decompress** — unpack the binary file, derive the key via PBKDF2, decrypt with AES-256-GCM, decompress with gunzip.
2. **Validate schema** — the decrypted JSON is validated against a Zod schema that checks for required fields and correct types. All records that will be stored in the database must have an `id` field.
3. **Check version** — if the payload version is higher than the current build supports, the import is rejected with a message to update the software.
4. **Create agent** — the `characterConfig` (if present) is merged as a base, then the `agent` record is overlaid. A new UUID is assigned. The agent is set to `enabled: true` with fresh timestamps.
5. **Create worlds** — each world gets a remapped ID and the new agent ID.
6. **Create rooms** — rooms are batch-created with remapped IDs, agent IDs, and world IDs.
7. **Create entities** — entities are batch-created with remapped IDs. Components are stripped (recreated separately).
8. **Add participants** — each participant record is added to its remapped room. User states (`FOLLOWED` or `MUTED`) are preserved.
9. **Create components** — each component gets a remapped ID, and all foreign key references (entity, agent, room, world, source entity) are remapped.
10. **Create memories** — each memory gets a remapped ID with remapped foreign keys. The memory table name is resolved from metadata or type field. Embeddings are left as `undefined` for regeneration.
11. **Create relationships** — source and target entity IDs are remapped.
12. **Create tasks** — task IDs and all reference IDs (room, world, entity) are remapped.
13. **Create logs** — log entity and room IDs are remapped.

### Import Result

A successful import returns:

```json
{
  "success": true,
  "agentId": "uuid-of-imported-agent",
  "agentName": "Agent Name",
  "counts": {
    "memories": 1234,
    "entities": 56,
    "components": 78,
    "rooms": 12,
    "participants": 34,
    "relationships": 5,
    "worlds": 1,
    "tasks": 8,
    "logs": 0
  }
}
```

### Requirements

- The agent must be **running** before you can export or import. If the agent is stopped, the API returns a 503 error.
- The password must match the one used during export. An incorrect password will fail with an authentication error.
- The runtime must have an active database adapter.

---

## ID Remapping

When an agent is imported, every UUID in the archive is remapped to a fresh `crypto.randomUUID()` value. This ensures the imported agent does not collide with existing data in the target database.

The remapping is deterministic within a single import operation: if the same old ID appears in multiple records (e.g., an entity ID referenced by a memory and a participant), it is always remapped to the same new ID. The remapper uses a `Map<string, string>` that grows lazily — the first time an old ID is encountered, a new UUID is generated and cached.

The only fixed mapping is the source agent ID, which is pre-mapped to the newly created agent UUID before any other records are processed.

This means:

- Imported agents always get new UUIDs.
- References between records (e.g., a memory referencing a room, a component referencing an entity) are preserved correctly.
- You can import the same archive multiple times and each import creates a fully independent agent.

---

## Character File Schema

The character definition controls the agent's personality, communication style, and behavior. Here is every field supported by the character schema:

### Core Fields

| Field | Type | Max Length | Description |
|-------|------|-----------|-------------|
| `name` | `string` | 100 chars | Agent display name |
| `username` | `string` | 50 chars | Agent username for platforms |
| `bio` | `string \| string[]` | — | Biography, either a single string or array of points |
| `system` | `string` | 10,000 chars | System prompt defining core behavior and personality |

### Personality Fields

| Field | Type | Description |
|-------|------|-------------|
| `adjectives` | `string[]` | Personality adjectives (e.g., "curious", "witty", "sardonic"). Each max 100 chars. |
| `topics` | `string[]` | Topics the agent is knowledgeable about. Each max 200 chars. |

### Style Rules

The `style` object controls how the agent communicates across different contexts:

```json
{
  "style": {
    "all": ["Keep responses concise", "Use technical terminology"],
    "chat": ["Be conversational", "Ask follow-up questions"],
    "post": ["Use short punchy sentences", "Include relevant hashtags"]
  }
}
```

| Sub-field | Type | Description |
|-----------|------|-------------|
| `style.all` | `string[]` | Style guidelines applied to all responses |
| `style.chat` | `string[]` | Additional guidelines for chat/conversation responses |
| `style.post` | `string[]` | Additional guidelines for social media posts |

### Message Examples

The `messageExamples` field provides example conversations that demonstrate the agent's voice. Each entry is a group containing an `examples` array of message pairs:

```json
{
  "messageExamples": [
    {
      "examples": [
        { "name": "{{user1}}", "content": { "text": "What do you think about DeFi?" } },
        { "name": "{{agentName}}", "content": { "text": "DeFi is fascinating but most protocols are still too complex for mainstream adoption.", "actions": ["CONTINUE"] } }
      ]
    }
  ]
}
```

Each message has:
- `name` — the speaker. Use `{{user1}}`, `{{user2}}`, etc. for users, and `{{agentName}}` for the agent.
- `content.text` — the message text (required, min 1 character).
- `content.actions` — optional array of action strings (e.g., `"CONTINUE"`).

### Post Examples

```json
{
  "postExamples": [
    "The future of AI agents isn't about replacing humans — it's about augmenting what we can do.",
    "Just discovered a new protocol that actually makes sense. Thread incoming."
  ]
}
```

### Full Character File Example

```json
{
  "name": "Reimu",
  "username": "reimu",
  "bio": [
    "Shrine maiden with a deep interest in decentralized systems.",
    "Known for straightforward communication and sharp analysis."
  ],
  "system": "You are Reimu, a thoughtful analyst who combines traditional wisdom with modern technology insights. You speak directly and avoid unnecessary jargon.",
  "adjectives": ["analytical", "direct", "curious", "pragmatic"],
  "topics": ["blockchain", "decentralized finance", "protocol design", "governance"],
  "style": {
    "all": ["Be concise and direct", "Use specific examples when possible"],
    "chat": ["Ask clarifying questions", "Reference previous conversation context"],
    "post": ["Keep posts under 280 characters", "Use a conversational tone"]
  },
  "messageExamples": [
    {
      "examples": [
        { "name": "{{user1}}", "content": { "text": "What's the biggest challenge in DeFi right now?" } },
        { "name": "{{agentName}}", "content": { "text": "Composability risk. Every protocol that integrates with another inherits its attack surface. We saw this with the curve pool exploits — one vulnerability cascaded across dozens of protocols." } }
      ]
    }
  ],
  "postExamples": [
    "The best protocols are the ones you forget are there. Infrastructure should be invisible.",
    "Governance tokens that don't govern anything aren't governance tokens. They're lottery tickets."
  ]
}
```

### Schema Validation

Character data is validated using a strict Zod schema. The schema enforces:

- Field types and maximum lengths
- Required sub-fields within nested objects (e.g., `content.text` must be at least 1 character)
- The `.strict()` modifier rejects unknown fields — extra properties cause validation errors

The character schema can be retrieved programmatically via `GET /api/character/schema`, which returns a structured description of all fields with their types, labels, and descriptions.

---

## Export Payload Schema

The full export payload (the JSON inside the encrypted file) follows this structure:

```typescript
interface AgentExportPayload {
  version: number;                    // currently 1
  exportedAt: string;                 // ISO 8601 timestamp
  sourceAgentId: string;              // original agent UUID
  agent: Partial<Agent>;              // database agent record
  characterConfig?: Record<string, unknown>;  // runtime character fields
  entities: Entity[];
  memories: Memory[];                 // embeddings stripped
  components: Component[];
  rooms: Room[];
  participants: Array<{
    entityId: string;
    roomId: string;
    userState: string | null;         // "FOLLOWED", "MUTED", or null
  }>;
  relationships: Relationship[];
  worlds: World[];
  tasks: Task[];
  logs: Log[];                        // empty array unless includeLogs was true
}
```

On import, this payload is validated with a Zod schema that requires:
- `version` — positive integer
- `exportedAt` — string
- `sourceAgentId` — string
- `agent` — record with string keys
- All array fields must contain objects with an `id` field (except `logs` and `participants`)
- `participants` entries must have `entityId`, `roomId`, and nullable `userState`

---

## Version Compatibility

The export format includes a `version` field (currently `1`). The import logic handles version compatibility as follows:

- If the payload version matches the current build version, the import proceeds normally.
- If the payload version is **lower** than the current build version, the import still proceeds. Future versions may apply migration logic for older payloads.
- If the payload version is **higher** than the current build version, the import is rejected with a message: `"Unsupported export version X. This build supports up to version Y. Please update your software to import this file."`

### Migration Between Versions

When upgrading Eliza, your existing `.eliza-agent` files remain compatible as long as the export version is not higher than what the new build supports. Best practices:

- Keep your `.eliza-agent` files after upgrading — they will still import.
- If you need to move an agent from a newer Eliza version to an older one, you may need to upgrade the target instance first.
- The `characterConfig` merge strategy (base with agent overlay) ensures that fields added in newer versions do not break imports on older versions — unknown fields are simply ignored by the Zod schema's strict mode during validation of sub-objects but preserved via the `Record<string, unknown>` type.

---

## Sharing Agents

To share an agent with another person:

1. **Export** the agent with a strong password using the dashboard or API.
2. Share the `.eliza-agent` file through any file transfer method (email, cloud storage, USB drive, etc.).
3. Share the password through a **separate channel** (never in the same message as the file).
4. The recipient imports the file into their Eliza instance using the same password.

Important considerations when sharing:

- **Secrets are excluded.** The recipient will need to configure their own API keys, wallet keys, and other credentials.
- **Memories are included.** All conversation history, facts, and documents the agent has accumulated are part of the export. If the agent has sensitive conversation data, consider whether sharing is appropriate.
- **Each import creates a new agent.** The recipient's imported agent is fully independent — changes to one do not affect the other.
- **Plugin references are included but not plugin code.** The recipient needs to have the same plugins installed for full functionality.

---

## elizaOS Compatibility

The `.eliza-agent` format uses the magic header `ELIZA_AGENT_V1`, reflecting its origin in the elizaOS ecosystem. The format is compatible with elizaOS instances that support the same export version.

Key compatibility details:

- The database schema types (`Agent`, `Memory`, `Entity`, `Component`, `Room`, `Task`, `World`, `Relationship`, `Log`) are imported from `@elizaos/core`.
- Memory table names (`messages`, `facts`, `documents`, `fragments`, `descriptions`, `character_modifications`, `custom`) follow the elizaOS convention.
- The `Task` type uses `agent_id` in the database schema but `agentId` in the TypeScript proto type. The export service handles both naming conventions when filtering tasks.
- The `characterConfig` field is Eliza-specific — elizaOS exports may not include it, but imports handle its absence gracefully.

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agent/export` | POST | Export agent as encrypted binary file |
| `/api/agent/export/estimate` | GET | Get estimated export size |
| `/api/agent/import` | POST | Import agent from encrypted binary file |
| `/api/character` | GET | Get current character configuration |
| `/api/character` | PUT | Update character configuration (validated) |
| `/api/character/schema` | GET | Get character field schema with types and descriptions |
| `/api/character/random-name` | GET | Generate a random agent name |
| `/api/character/generate` | POST | AI-generate character fields (bio, system, style, chat examples, post examples) |

### Character Generation

The `POST /api/character/generate` endpoint uses AI to generate character content. Request body:

```json
{
  "field": "bio",
  "context": {
    "name": "Reimu",
    "system": "A shrine maiden interested in technology",
    "bio": "Existing bio text",
    "topics": ["technology", "spirituality"],
    "style": { "all": ["Be direct"] }
  },
  "mode": "append"
}
```

Supported fields: `bio`, `system`, `style`, `chatExamples`, `postExamples`. The `mode` parameter (`append` or `replace`) controls whether generated content is added to existing content or replaces it. The `context.topics` parameter accepts an array of topic strings to provide the agent's topic list as additional context for more relevant generation. The generation uses the `TEXT_SMALL` model with a temperature of 0.8.

---

## Troubleshooting

### Export fails with "Agent is not running"

The agent must be started before exporting. The export service needs an active database adapter to query agent data. Start the agent first, then retry the export.

### "Incorrect password" on import

The password must exactly match the one used during export. AES-GCM authentication will fail on even a single wrong character. There is no password recovery — if you lose the password, the file cannot be decrypted.

### Import fails with schema validation error

The decrypted payload is validated against a strict schema. Common causes:

- The file was exported from an incompatible version.
- The file is corrupt (though AES-GCM authentication should catch most corruption).
- The file is not a valid `.eliza-agent` file at all.

The error message includes the specific fields that failed validation (e.g., `"entities.3.id: Required"`).

### "Unsupported export version"

The file was created by a newer version of Eliza than the one you are running. Upgrade your Eliza installation to import the file.

### Export file is very large

- Set `includeLogs: false` (the default) to exclude execution logs, which can be substantial.
- Embeddings are already stripped from memories during export.
- The file is gzip-compressed before encryption, which typically provides 60-80% compression for text-heavy data.
- Use the `GET /api/agent/export/estimate` endpoint to check the expected size before exporting.

### "Decompressed payload exceeds import limit"

The import has a 16 MiB safety cap on decompressed data. If your agent has an exceptionally large amount of data, you may need to export without logs, or consider pruning old memories before exporting.

### Imported agent has no API keys or wallet

This is expected behavior. Secrets (API keys, private keys, credentials) are never included in exports. After importing, configure the new agent's credentials through the dashboard or API.
