# Cognitive Architecture Notes for Memory System Design

## Date: 2024-01-12
## Author: Research Team
## Purpose: Inform the technical architecture with cognitive science foundations

---

## 1. Atkinson-Shiffrin Model (1968)

The classic multi-store model proposes three stages of memory:

### Sensory Memory
- Ultra-short duration (250ms – 3 seconds)
- High capacity but rapid decay
- **Design implication:** In our system, this maps to the raw input buffer — the unprocessed text of the current user message. We don't need to persist this; it's handled by the LLM context window.

### Short-Term Memory (STM)
- Duration: 15–30 seconds without rehearsal
- Capacity: 7 ± 2 items (Miller, 1956)
- Maintained through active rehearsal
- **Design implication:** This maps to our **working memory layer**. Should hold approximately 7–15 active items. Must be fast to access (sub-second). Items decay unless explicitly promoted.

### Long-Term Memory (LTM)
- Potentially unlimited capacity and duration
- Encoded through elaborative rehearsal and meaningful association
- **Design implication:** This maps to our **episodic + semantic layers** combined. The key insight is that LTM is not a single store — see Tulving's distinction below.

---

## 2. Tulving's Memory Taxonomy (1972, 1983)

Endel Tulving distinguished between two types of long-term memory:

### Episodic Memory
- Memory for **personal experiences and events**
- Always tied to a specific time and place (spatiotemporal context)
- "I remember discussing the API design on Tuesday afternoon"
- Encoded with rich contextual detail
- Subject to forgetting and distortion over time
- **Design implication:** Our episodic layer must include:
  - Precise timestamps
  - Session context (what was being discussed, what project)
  - Emotional/importance markers (user explicitly flagged something as important)
  - Links to related episodes ("this is a follow-up to the conversation on Jan 10")

### Semantic Memory
- Memory for **general knowledge and facts**
- Detached from specific episodes — you know Paris is the capital of France but don't remember when you learned it
- Organized conceptually, not temporally
- More stable and resistant to forgetting
- **Design implication:** Our semantic layer should contain:
  - Extracted facts ("User prefers pytest over unittest")
  - Conceptual summaries ("User is building a data pipeline in Python")
  - Entity knowledge ("Project Alpha uses PostgreSQL 15 and FastAPI")
  - Relationships between concepts
  - Provenance links back to source episodes (even though the knowledge itself is decontextualized)

---

## 3. Baddeley's Working Memory Model (1974, 2000)

Alan Baddeley refined the concept of short-term memory into a multi-component working memory:

### Central Executive
- Attentional control system
- Directs focus, coordinates subsystems
- **Design implication:** This is the retrieval/ranking algorithm that decides which memories to surface for a given query.

### Phonological Loop
- Handles verbal/acoustic information
- Maintains through subvocal rehearsal
- **Design implication:** Less directly relevant to text-based AI, but analogous to maintaining the current conversation thread.

### Visuospatial Sketchpad
- Handles visual and spatial information
- **Design implication:** Not directly applicable to our text-based system, but could inform future multimodal memory.

### Episodic Buffer (added 2000)
- Integrates information from multiple sources into coherent episodes
- Limited capacity (~4 chunks)
- Interface between working memory and long-term memory
- **Design implication:** This is critical — we need a component that combines working memory items with retrieved long-term memories into a coherent context for the LLM. This is essentially the "context assembly" step.

---

## 4. Memory Consolidation

The process by which memories transition from episodic to semantic storage:

### Key Principles
1. **Repetition strengthens consolidation** — frequently accessed episodic memories are more likely to produce semantic entries
2. **Sleep consolidation** — in humans, memories are consolidated during sleep. Our analog: the **nightly distillation process**.
3. **Interference** — new similar memories can interfere with old ones. Our system should handle updates/corrections to semantic entries.
4. **Spacing effect** — distributed review is more effective than massed review. Distillation should review memories at increasing intervals.

### Consolidation Pipeline (proposed)
```
Episodic Entry → Frequency/Importance Scoring → Candidate Selection → 
Fact Extraction → Deduplication → Semantic Entry Creation → 
Provenance Linking → Verification (optional human review)
```

---

## 5. Forgetting and Decay

### Ebbinghaus Forgetting Curve
- Memory strength decays exponentially without reinforcement
- **Design implication:** We could implement a relevance decay function for episodic memories, but we should NOT delete them — just deprioritize in search results. The project brief requires long retention periods.

### Retrieval-Induced Forgetting
- Retrieving some memories can inhibit access to related memories
- **Design implication:** Our search algorithm should be aware of this — don't always return the same top results. Consider diversity in search results.

---

## 6. Summary of Design Implications

| Cognitive Concept | System Component | Key Constraint |
|---|---|---|
| STM / 7±2 items | Working Memory | Max 15 items, < 500ms access |
| Episodic Memory | Episodic Layer | Timestamped, contextual, searchable |
| Semantic Memory | Semantic Layer | Abstracted facts, concept-organized |
| Consolidation | Distillation Pipeline | Periodic, preserves provenance |
| Episodic Buffer | Context Assembly | Integrates working + retrieved memories |
| Forgetting Curve | Relevance Scoring | Decay function, but never hard-delete |

---

## References
- Atkinson, R.C. & Shiffrin, R.M. (1968). Human memory: A proposed system and its control processes.
- Tulving, E. (1972). Episodic and semantic memory.
- Baddeley, A.D. & Hitch, G. (1974). Working memory.
- Baddeley, A.D. (2000). The episodic buffer: a new component of working memory?
- Miller, G.A. (1956). The magical number seven, plus or minus two.
- Ebbinghaus, H. (1885). Memory: A contribution to experimental psychology.
