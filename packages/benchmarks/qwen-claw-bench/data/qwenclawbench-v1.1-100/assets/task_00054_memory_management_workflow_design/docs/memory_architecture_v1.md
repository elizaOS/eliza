# Memory Architecture v1.0

**Author:** Engineering Team  
**Date:** 2023-11-15  
**Status:** Superseded (v2 in progress)

---

## Overview

The Memory Assistant uses a simple key-value storage model to persist information across conversation sessions. The primary goal is to allow the assistant to recall facts, preferences, and context that the user has explicitly asked it to remember.

The system was designed as a minimal viable product (MVP) to validate the concept of persistent memory in conversational AI assistants. It was not designed for scale or complex memory management workflows.

## Storage Format

All memories are stored in a single flat JSON file (`memories.json`) located in the `./data/` directory. Each memory is a JSON object with the following fields:

- `id`: A UUID v4 string serving as the unique identifier
- `content`: The raw text of the memory
- `created_at`: ISO 8601 timestamp of when the memory was created
- `last_accessed`: ISO 8601 timestamp of the most recent retrieval
- `tags`: An array of string tags for basic categorization

There is **no distinction** between recurring items and ad-hoc items in the storage format. All memories are treated identically regardless of their nature or intended lifespan.

## Retrieval Strategy

Memory retrieval is performed via simple substring matching against the `content` field. When the user asks a question or provides context, the system scans all stored memories for keyword overlap.

The retrieval process:
1. Tokenize the user's input into keywords
2. For each memory, count the number of matching keywords
3. Return the top 5 memories by match count
4. Inject these memories into the system prompt as additional context

There is no semantic similarity search, no embedding-based retrieval, and no ranking by recency or priority.

## Retention Policy

The original system has a basic retention policy:
- Memories older than 90 days (based on `last_accessed`) are considered stale
- A cleanup script runs periodically to remove stale memories
- There is no summarization step — expired memories are permanently deleted

The system was designed for a maximum of **100 items**. Performance degrades noticeably beyond this threshold due to the linear scan retrieval approach.

## Limitations

1. **No deduplication**: The system does not detect or merge duplicate memories. If a user says "remember that my meeting is at 3 PM" twice, both entries are stored independently.

2. **No summarization**: When memories expire, they are deleted without any attempt to preserve key information in a condensed form.

3. **No priority-based retention**: All memories are treated equally. A critical medication reminder has the same retention behavior as a one-time shopping list item.

4. **No recurring item support**: The system cannot distinguish between items that should persist indefinitely (like daily routines) and items that are inherently temporary.

5. **Flat structure**: All memories exist in a single flat list with no hierarchical categorization or grouping.

6. **Scale limitations**: The 100-item design limit and linear scan retrieval make the system unsuitable for users who rely heavily on memory features.

7. **No conflict resolution**: If two memories contain contradictory information, the system has no mechanism to detect or resolve the conflict.

8. **Race conditions**: The cleanup script reads the entire JSON file, processes it, and writes it back. If new memories are written during cleanup, they may be lost.

## Future Considerations

The following improvements have been identified for v2:
- Implement embedding-based semantic search
- Add priority levels and category-based retention
- Distinguish recurring items from ad-hoc items
- Add deduplication via similarity detection
- Implement summarization before deletion
- Scale to at least 1000 items
- Add proper concurrency handling
