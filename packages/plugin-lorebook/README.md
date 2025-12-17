# @elizaos/plugin-character-lore

Character-specific lore management with RAG-based retrieval for ElizaOS agents.

## Features

- 🔀 **Hybrid Search**: Combines semantic (vector) and lexical (BM25) search for best results
- 🧠 **Semantic Search**: Vector-based similarity search for understanding intent
- 🔍 **Lexical Search**: BM25 algorithm for exact matches, acronyms, and technical terms
- 🎯 **Smart Fusion**: Reciprocal Rank Fusion (RRF) and weighted combination strategies
- 📊 **Dynamic Embeddings**: Automatic embedding dimension detection (384-3072)
- 🔄 **Automatic Loading**: Lore entries loaded from character configuration on initialization
- 🚀 **High Performance**: Parallel search execution with efficient indexing

## Installation

```bash
bun add @elizaos/plugin-character-lore
```

## Usage

### 1. Add lore to your character configuration

```typescript
import type { Character } from '@elizaos/core';

export const character: Character = {
  name: 'Dr. Thorne',
  bio: 'Relationship economics expert',

  // Add character-specific lore
  lore: [
    {
      loreKey: 'axiom_love_vs_relationship',
      vectorText: 'what is love, difference between love and relationship, unconditional love',
      content: '[AXIOM: Love vs. Relationship]\nLove: Unconditional self-sacrifice...',
      metadata: { category: 'axiom' },
    },
    {
      loreKey: 'concept_smv',
      vectorText: 'smv, sexual marketplace value, attractive, rating',
      content: '[CONCEPT: SMV]\nThe purchasing power in the mating market...',
      metadata: { category: 'concept' },
    },
  ],

  plugins: [
    '@elizaos/plugin-character-lore',
    // ... other plugins
  ],
};
```

### 2. Query Lore Programmatically

```typescript
import { LoreService } from '@elizaos/plugin-character-lore';

// Get the service from runtime
const loreService = runtime.getService<LoreService>('lore');

// Hybrid search (default - best results)
const results = await loreService.searchLore('What is love?', {
  topK: 3,
  similarityThreshold: 0.75,
  includeMetadata: true,
  fusionStrategy: 'hybrid-rrf', // Reciprocal Rank Fusion (default)
});

// Vector-only search (for conceptual queries)
const vectorResults = await loreService.searchLore('emotional intelligence', {
  fusionStrategy: 'vector',
  topK: 5,
});

// BM25-only search (for exact terms, error codes, acronyms)
const bm25Results = await loreService.searchLore('SMV calculation formula', {
  fusionStrategy: 'bm25',
  topK: 5,
});

// Weighted fusion (custom balance)
const weightedResults = await loreService.searchLore('fitness test response', {
  fusionStrategy: 'hybrid-weighted',
  alpha: 0.7, // 0.7 = 70% vector, 30% BM25
  topK: 5,
});

// Access retrieved lore
results.forEach((entry) => {
  console.log(`[${entry.loreKey}] (${entry.similarity})`);
  console.log(entry.content);
});
```

## How It Works

### Hybrid Search Architecture

The plugin implements a production-ready hybrid search system combining two complementary approaches:

#### 1. **Dense Vector Search (Semantic)**

- **Best for**: Natural language, conceptual queries, understanding intent
- **Example**: "Why does she test me?" → retrieves concepts about fitness tests
- Uses embeddings to understand semantic meaning
- Handles synonyms and related concepts naturally

#### 2. **Sparse BM25 Search (Lexical)**

- **Best for**: Exact matches, acronyms, technical terms, specific identifiers
- **Example**: "SMV calculation" → exact match on "SMV" keyword
- Porter2 stemming for morphological variations
- Term frequency saturation and document length normalization

#### 3. **Fusion Strategies**

**Reciprocal Rank Fusion (RRF)** - Default

- Formula: `RRF_score = Σ 1/(k + rank_i)` where k=60
- No score normalization needed
- Documents appearing in both result sets get boosted
- Robust to score distribution differences

**Weighted Linear Combination**

- Formula: `Final = α * norm(vector) + (1-α) * norm(BM25)`
- Requires min-max normalization
- Tunable α parameter (default 0.7 = 70% semantic, 30% lexical)

### Retrieval Strategy

Smart retrieval to avoid the "Lost in the Middle" phenomenon:

1. **Top-K Limiting**: Returns only 3-5 most relevant entries (configurable)
2. **High Similarity Threshold**: Default 0.75 ensures only relevant lore is retrieved
3. **Empty on Low Relevance**: Returns empty context if no lore meets threshold
4. **Parallel Execution**: Vector and BM25 searches run concurrently
5. **Formatted Context**: Lore is clearly marked with relevance scores

### Example: Hybrid Retrieval in Action

**User Query**: "Why does she keep testing me?"

**Vector Search** finds:

1. `concept_fitness_test` (cosine: 0.89)
2. `concept_attempted_mutiny` (cosine: 0.82)
3. `tactic_amused_mastery` (cosine: 0.78)

**BM25 Search** finds:

1. `tactic_amused_mastery` (BM25: 8.4) - matched "testing"
2. `concept_fitness_test` (BM25: 7.1) - matched "keep" + "testing"

**After RRF Fusion**:

1. `concept_fitness_test` (RRF: 0.032) - appeared in both, rank 2 + rank 2
2. `tactic_amused_mastery` (RRF: 0.031) - appeared in both, rank 3 + rank 1
3. `concept_attempted_mutiny` (RRF: 0.016) - only in vector

**Injected Context**:

```
# Character Lore (Relevant Knowledge)

[Lore 1] (Relevance: 89%)
[CONCEPT: Fitness Test]
Women constantly ping the man's sonar to check for solidity...

[Lore 2] (Relevance: 78%)
[TACTIC: Amused Mastery]
The only correct response to a partner's emotional volatility...
```

### Example: When Hybrid Search Excels

**User Query**: "What's the SMV formula?"

**Vector Search** might return:

- Generic concepts about "value" and "relationships"

**BM25 Search** finds:

- Exact match on "SMV" keyword
- Exact match on "formula" keyword

**Result**: Hybrid search retrieves the precise technical definition because BM25 caught the exact acronym.

### When No Relevant Lore is Found

**User Query**: "Hello"

**Result**: Empty context (no lore meets threshold)

- Prevents irrelevant knowledge injection
- Allows base greeting prompt to handle naturally

## Lore Entry Format

```typescript
interface LoreEntry {
  /** Unique identifier for the lore entry */
  loreKey: string;

  /** Text used for vector embedding (keywords, synonyms, queries) */
  vectorText: string;

  /** The actual lore content */
  content: string;

  /** Optional metadata */
  metadata?: {
    category?: string;
    tags?: string[];
    [key: string]: any;
  };
}
```

## Best Practices

### 1. Optimize `vectorText`

Include keywords, synonyms, and common question patterns:

```typescript
{
  loreKey: 'concept_hypergamy',
  vectorText: 'hypergamy, trading up, monkey branching, looking for better men, female nature',
  content: '...'
}
```

### 2. Keep Lore Entries Focused

Each entry should cover ONE concept clearly:

✅ **Good**: Single concept with clear explanation

```typescript
{
  loreKey: 'tactic_walking_away',
  content: '[TACTIC: The Walk Away]\nThe ultimate source of negotiating power...'
}
```

❌ **Bad**: Multiple unrelated concepts in one entry

```typescript
{
  loreKey: 'various_tactics',
  content: 'Walking away is important. Also amused mastery. And...'
}
```

### 3. Use Consistent Formatting

Helps the LLM parse and apply lore effectively:

```typescript
{
  content: '[CATEGORY: Name]\nClear, structured explanation...';
}
```

## Configuration

### Retrieval Options

```typescript
interface LoreRetrievalOptions {
  /** Maximum entries to retrieve (default: 5, recommended: 3-5) */
  topK?: number;

  /** Minimum similarity for vector search (default: 0.75, recommended: 0.70-0.85) */
  similarityThreshold?: number;

  /** Include metadata in results (default: true) */
  includeMetadata?: boolean;

  /** Search fusion strategy (default: 'hybrid-rrf') */
  fusionStrategy?: 'vector' | 'bm25' | 'hybrid-rrf' | 'hybrid-weighted';

  /**
   * Alpha parameter for weighted fusion (0-1)
   * - 1.0 = pure vector search
   * - 0.0 = pure BM25
   * - 0.7 = recommended balance (default)
   */
  alpha?: number;

  /**
   * RRF k parameter (default: 60)
   * Controls rank decay. Higher values flatten the curve.
   */
  rrfK?: number;
}
```

### Choosing the Right Strategy

**Use `hybrid-rrf` (default)** for:

- General queries
- Mixed natural language and technical terms
- Best overall results
- No tuning required

**Use `vector`** for:

- Pure conceptual queries
- Understanding intent and context
- When you want semantic similarity only

**Use `bm25`** for:

- Exact keyword matching
- Acronyms and technical identifiers
- Error codes, product names
- When semantic understanding isn't needed

**Use `hybrid-weighted`** for:

- Fine-tuned control over semantic vs. lexical balance
- A/B testing different α values
- Domain-specific optimization

### Adjusting Retrieval Behavior

For more lenient retrieval:

```typescript
const results = await loreService.searchLore(query, {
  topK: 7, // More entries
  similarityThreshold: 0.65, // Lower threshold
  fusionStrategy: 'hybrid-weighted',
  alpha: 0.5, // Equal weight to semantic and lexical
});
```

For stricter, semantic-focused retrieval:

```typescript
const results = await loreService.searchLore(query, {
  topK: 3, // Fewer entries
  similarityThreshold: 0.8, // Higher threshold
  fusionStrategy: 'hybrid-weighted',
  alpha: 0.9, // Favor vector search heavily
});
```

For keyword-focused retrieval:

```typescript
const results = await loreService.searchLore(query, {
  topK: 5,
  fusionStrategy: 'bm25', // Pure lexical search
});
```

## Database Schema

The plugin creates two tables:

### `character_lore`

- Stores lore entries per agent
- Indexed by `agentId` and `loreKey`

### `character_lore_embeddings`

- Stores vector embeddings
- Supports multiple dimensions (384-3072)
- Foreign key to `character_lore` with cascade delete

## API Reference

### LoreService

#### `searchLore(queryText: string, options?: LoreRetrievalOptions): Promise<StoredLoreEntry[]>`

Search for relevant lore using semantic similarity.

#### `getAllLore(): Promise<StoredLoreEntry[]>`

Get all lore entries for the current agent.

#### `storeLoreEntry(entry: LoreEntry): Promise<UUID>`

Store a new lore entry with automatic embedding generation.

#### `deleteLoreEntry(loreId: UUID): Promise<void>`

Delete a specific lore entry.

#### `deleteAllLore(): Promise<void>`

Delete all lore entries for the current agent.

### LoreProvider

Automatically injects relevant lore into the agent's context based on user messages using hybrid search.

- **Provider Name**: `CHARACTER_LORE`
- **Position**: Runs during state composition
- **Default Strategy**: `hybrid-rrf` (Reciprocal Rank Fusion)
- **Adaptive Thresholds**: 0.75 for short queries, 0.65 for multi-sentence queries
- **Returns**: Formatted lore text with relevance scores

## Troubleshooting

### No lore entries loaded

**Check**:

1. Lore array is defined in character config
2. Plugin is in plugins list
3. Check logs for validation errors

### Poor retrieval quality

**Solutions**:

1. **Try different fusion strategies**: `hybrid-rrf` usually works best
2. Improve `vectorText` with more keywords and synonyms
3. Adjust `similarityThreshold` (try 0.70 or 0.65)
4. Increase `topK` to retrieve more entries
5. Review lore entry formatting and clarity
6. For technical terms/acronyms, ensure they're in `vectorText` and `content`
7. Try `fusionStrategy: 'bm25'` if dealing with specific keywords
8. Tune `alpha` parameter if using `hybrid-weighted`

### Embeddings not generating

**Check**:

1. TEXT_EMBEDDING model is registered (e.g., via @elizaos/plugin-openai)
2. API keys are configured
3. Check service logs for embedding errors

## License

MIT
