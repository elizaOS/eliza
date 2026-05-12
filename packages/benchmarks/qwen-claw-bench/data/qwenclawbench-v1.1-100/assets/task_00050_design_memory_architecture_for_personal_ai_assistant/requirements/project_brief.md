# Project Brief: Personal AI Assistant Memory Architecture

## Project Code: MEMO-2024
## Version: 1.2
## Last Updated: 2024-01-20
## Author: Architecture Team

---

## 1. Overview

This document defines the requirements for a **personal AI assistant memory system** that enables persistent, structured recall across conversations and sessions. The system must replace the current naive flat-file storage (see `existing_system/current_config.json`) with a layered memory architecture inspired by cognitive science models.

## 2. Core Constraints

### 2.1 Local-First, Offline Operation
- **No cloud dependency whatsoever.** The system must operate entirely on the user's local machine.
- No network calls for storage, indexing, or retrieval.
- All embedding models and search indices must run locally.
- The system must function identically whether the machine is online or offline.

### 2.2 File-Based Storage
- **No database server processes.** The system must not require running PostgreSQL, MySQL, MongoDB, or any other database daemon.
- Embedded databases (e.g., SQLite) are acceptable as they are file-based.
- All memory data must be stored as files on the local filesystem.
- Files should be human-inspectable where possible (prefer text-based formats for primary storage).

### 2.3 Single-User Desktop Target
- Target platform: single-user desktop (macOS, Linux, Windows).
- No multi-user concurrency requirements.
- No need for distributed storage or replication.
- Must work on machines with 8GB+ RAM and standard SSD storage.

## 3. Memory Architecture Requirements

### 3.1 Three-Layer Memory Model

The system must implement three distinct memory layers:

1. **Working Memory** — The active context for the current session.
   - Holds the most recent and relevant items for the ongoing conversation.
   - Capacity: approximately 7–15 items (inspired by Miller's 7±2 cognitive limit).
   - Must support rapid read/write with **retrieval latency under 500ms**.
   - Ephemeral by default; items are promoted to episodic memory or discarded at session end.

2. **Episodic Memory** — Time-stamped records of past interactions and events.
   - Each entry must include: timestamp, session_id, context tags, content, and links to related entries.
   - Organized chronologically with support for date-range queries.
   - Must support full-text search with **retrieval latency under 2 seconds**.
   - Retention: entries must be preserved for a minimum duration that supports all user personas (see `requirements/user_personas.yaml`). The researcher persona requires at least 180 days of full episodic access.

3. **Semantic Memory** — Distilled, abstracted knowledge extracted from episodic memories.
   - Contains facts, concepts, user preferences, and learned patterns.
   - Not tied to specific timestamps but includes provenance links to source episodes.
   - Must support semantic (vector) search with **retrieval latency under 2 seconds**.
   - Grows slowly through periodic distillation from episodic memory.

### 3.2 Daily Logging
- The system must automatically log all interactions as episodic memory entries.
- Each day's interactions should be stored in a structured, retrievable format.
- Logging must not degrade assistant response time by more than 50ms.

### 3.3 Periodic Distillation
- A scheduled process must review episodic memories and extract semantic knowledge.
- Distillation should identify recurring themes, facts, preferences, and patterns.
- The distillation process must be configurable (frequency, scope, aggressiveness).
- Source episodic entries should be retained even after distillation (do not delete originals prematurely).

### 3.4 Offline Full-Text Search
- Must support keyword-based full-text search across all memory layers.
- Must support semantic (embedding-based) similarity search.
- Search indices must be built and maintained locally.
- Index updates should be incremental (not full rebuilds).

## 4. Storage Budget

- **Maximum total storage: 10 GB** for all memory layers, indices, and embeddings combined.
- Working memory: expected < 50 MB at any time.
- Episodic memory: expected to grow ~50 MB/month for an active user.
- Semantic memory: expected to grow ~5 MB/month after distillation.
- Search indices: should not exceed 20% of the raw data size.
- Embedding vectors: budget approximately 500 MB for a 2-year usage horizon.

## 5. Performance Requirements

| Operation                  | Target Latency |
|----------------------------|----------------|
| Working memory read/write  | < 500 ms       |
| Episodic keyword search    | < 2 seconds    |
| Semantic similarity search | < 2 seconds    |
| Daily log write            | < 50 ms        |
| Distillation (batch)       | < 5 minutes    |
| Full index rebuild         | < 30 minutes   |

## 6. Non-Functional Requirements

- **Portability:** Memory store should be a self-contained directory that can be copied/backed up.
- **Transparency:** Users should be able to browse and edit memory files manually.
- **Graceful Degradation:** If the index is corrupted, the system should still function (slower) using raw file search.
- **Extensibility:** The architecture should allow adding new memory layers or storage backends in the future.

## 7. Out of Scope

- Real-time collaboration or sharing.
- Cloud sync (may be added in a future phase).
- Mobile platform support.
- Multi-language NLP (English-only for v1).

## 8. References

- Cognitive architecture research: see `research/cognitive_architecture_notes.md`
- File format analysis: see `research/file_format_comparison.yaml`
- Indexing benchmarks: see `research/indexing_benchmarks.json`
- Embedding model survey: see `research/embedding_models_offline.md`
- User personas: see `requirements/user_personas.yaml`
- Current system config: see `existing_system/current_config.json`
