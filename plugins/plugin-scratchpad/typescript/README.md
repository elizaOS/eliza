# @elizaos/plugin-scratchpad

File-based memory storage plugin for elizaOS. Provides persistent notes and memories that can be written, read, searched, and managed across sessions.

## Overview

This plugin enables agents to maintain a persistent scratchpad of notes and memories stored as markdown files. It's inspired by the Otto memory-core extension and provides similar functionality adapted for the elizaOS plugin architecture.

## Features

- **Persistent Storage**: Notes are stored as markdown files that persist across sessions
- **Semantic Search**: Search through entries by content with relevance scoring
- **CRUD Operations**: Full support for Create, Read, Update (append), and Delete
- **Tagging**: Organize entries with tags for better categorization
- **Provider Integration**: Automatic context about scratchpad state for the agent

## Installation

```bash
npm install @elizaos/plugin-scratchpad
```

## Usage

Add the plugin to your agent configuration:

```typescript
import { scratchpadPlugin } from "@elizaos/plugin-scratchpad";

const agent = {
  // ... other config
  plugins: [scratchpadPlugin],
};
```

## Actions

### SCRATCHPAD_WRITE

Create a new scratchpad entry.

**Similes**: SAVE_NOTE, CREATE_NOTE, WRITE_NOTE, REMEMBER_THIS, SAVE_MEMORY, JOT_DOWN, NOTE_THIS

**Example**:
```
User: "Please save a note about the meeting tomorrow at 3pm with John"
Agent: "I've saved a note titled 'Meeting with John'. You can retrieve it later."
```

### SCRATCHPAD_READ

Read the content of a specific scratchpad entry.

**Similes**: GET_NOTE, READ_NOTE, RETRIEVE_NOTE, GET_MEMORY, FETCH_NOTE, OPEN_NOTE

**Example**:
```
User: "Show me the note about the meeting"
Agent: "Here's the note 'Meeting with John': Meeting scheduled for tomorrow at 3pm..."
```

### SCRATCHPAD_SEARCH

Search through scratchpad entries for relevant information.

**Similes**: FIND_NOTE, SEARCH_NOTES, LOOKUP_MEMORY, FIND_MEMORY, SEARCH_MEMORY, RECALL

**Example**:
```
User: "What notes do I have about marketing?"
Agent: "I found 2 entries mentioning marketing: 1) 'Marketing Strategy' (85% match)..."
```

### SCRATCHPAD_LIST

List all scratchpad entries with their titles and modification dates.

**Similes**: SHOW_NOTES, LIST_NOTES, ALL_NOTES, MY_NOTES, SHOW_MEMORIES

**Example**:
```
User: "Show me all my saved notes"
Agent: "You have 5 scratchpad entries: 1) Meeting notes (modified today)..."
```

### SCRATCHPAD_APPEND

Append additional content to an existing scratchpad entry.

**Similes**: ADD_TO_NOTE, UPDATE_NOTE, APPEND_NOTE, EXTEND_NOTE, ADD_MORE

**Example**:
```
User: "Add to the meeting notes that we decided on a $50k budget"
Agent: "I've appended the budget decision to the meeting notes."
```

### SCRATCHPAD_DELETE

Delete a scratchpad entry by its ID.

**Similes**: REMOVE_NOTE, DELETE_NOTE, FORGET_NOTE, ERASE_NOTE, REMOVE_MEMORY

**Example**:
```
User: "Delete the note about the old meeting"
Agent: "I've deleted the scratchpad entry 'old-meeting'."
```

## Provider

### scratchpad

Provides information about the user's scratchpad entries to the agent's context. This allows the agent to be aware of saved notes without explicitly querying.

The provider returns:
- Summary of recent entries (up to 5)
- Total count of entries
- Entry IDs and titles

## Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| SCRATCHPAD_BASE_PATH | string | ~/.eliza/scratchpad | Base directory for scratchpad files |
| SCRATCHPAD_MAX_FILE_SIZE | number | 1048576 | Maximum file size in bytes (1MB) |

## File Format

Entries are stored as markdown files with YAML frontmatter:

```markdown
---
title: "Meeting with John"
created: 2024-01-15T10:30:00.000Z
modified: 2024-01-15T10:30:00.000Z
tags: [meeting, marketing]
---

Meeting scheduled for tomorrow at 3pm to discuss marketing strategy.
```

## Development

```bash
# Build
bun run build

# Type check
bun run typecheck

# Lint
bun run lint

# Test
bun run test
```

## License

MIT
