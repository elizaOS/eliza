# @elizaos/plugin-memory

Advanced memory management plugin for ElizaOS that provides intelligent conversation summarization and persistent long-term memory storage.

## Features

### 🔄 Short-term Memory (Conversation Summarization)

- **Automatic Summarization**: Compresses long conversations when they exceed configurable thresholds
- **Context Preservation**: Maintains conversation flow while dramatically reducing token usage
- **Recent Message Retention**: Keeps the most recent messages for immediate context
- **Topic Extraction**: Identifies and tracks main topics discussed in each session

### 🧠 Long-term Memory (Persistent Facts)

- **Intelligent Extraction**: Automatically learns facts about users from conversations
- **Categorized Storage**: Organizes information into 9 semantic categories
- **Confidence Scoring**: Tracks reliability of stored information
- **Cross-session Persistence**: Remembers user preferences and context across all interactions

### 📊 Memory Categories

1. **Identity**: User's name, role, profession (e.g., "I'm a data scientist")
2. **Expertise**: Domain knowledge, skills, familiarity with topics
3. **Projects**: Ongoing work, past interactions, recurring topics
4. **Preferences**: Communication style, format preferences, verbosity
5. **Data Sources**: Frequently used files, databases, APIs
6. **Goals**: Broader intentions and objectives
7. **Constraints**: User-defined rules or limitations
8. **Definitions**: Custom terms, acronyms, glossaries
9. **Behavioral Patterns**: Interaction styles and tendencies

## Installation

```bash
bun add @elizaos/plugin-memory
```

## Usage

### Basic Setup

```typescript
import { memoryPlugin } from '@elizaos/plugin-memory';

const agent = new Agent({
  name: 'MyAgent',
  plugins: [
    memoryPlugin,
    // ... other plugins
  ],
});
```

### Configuration

Configure the plugin via environment variables in your `.env` file:

```env
# Short-term Memory Settings
MEMORY_SUMMARIZATION_THRESHOLD=50  # Messages before summarization (default: 50)
MEMORY_RETAIN_RECENT=10           # Recent messages to keep (default: 10)

# Long-term Memory Settings
MEMORY_LONG_TERM_ENABLED=true     # Enable long-term extraction (default: true)
MEMORY_CONFIDENCE_THRESHOLD=0.7   # Minimum confidence to store (default: 0.7)
```

### Manual Memory Storage

Users can explicitly ask the agent to remember information:

```
User: "Remember that I prefer TypeScript over JavaScript"
Agent: I've made a note of that in my Preferences memory: "User prefers TypeScript over JavaScript"

User: "Keep in mind I'm working on a startup project"
Agent: I've made a note of that in my Projects memory: "User is working on a startup project"

User: "Don't forget I use Python 3.11"
Agent: I've made a note of that in my Data Sources memory: "User uses Python 3.11"
```

### Accessing the Memory Service

```typescript
import { MemoryService } from '@elizaos/plugin-memory';

// Get the service from runtime
const memoryService = runtime.getService('memory') as MemoryService;

// Store a long-term memory manually
await memoryService.storeLongTermMemory({
  agentId: runtime.agentId,
  entityId: userId,
  category: LongTermMemoryCategory.PREFERENCES,
  content: 'User prefers concise responses',
  confidence: 0.9,
  source: 'manual',
});

// Retrieve memories
const memories = await memoryService.getLongTermMemories(userId);

// Get session summaries
const summaries = await memoryService.getSessionSummaries(roomId);
```

## Database Setup

The plugin uses ElizaOS's dynamic migration system. Database tables are automatically created when the plugin is loaded. The plugin defines three tables:

- **`long_term_memories`**: Stores persistent facts about users
- **`session_summaries`**: Stores conversation summaries
- **`memory_access_logs`**: Optional usage tracking for analytics

No manual migration is required - the schema is handled automatically by the runtime.

## Architecture

### Components

#### Services

- **MemoryService**: Core service managing all memory operations
  - Tracks message counts for summarization triggers
  - Stores and retrieves long-term memories
  - Manages session summaries
  - Provides formatted memory context

#### Evaluators

- **summarizationEvaluator**: Runs after conversations reach threshold
  - Generates comprehensive summaries using LLM
  - Extracts topics and key points
  - Archives old messages while preserving summaries
- **longTermExtractionEvaluator**: Periodically analyzes conversations
  - Identifies facts worth remembering long-term
  - Categorizes information semantically
  - Assigns confidence scores
  - Stores high-confidence memories

#### Providers

- **longTermMemoryProvider**: Injects persistent user facts into context
  - Runs early (position: 50) to establish user context
  - Formats memories by category
  - Provides "What I Know About You" context
- **shortTermMemoryProvider**: Provides conversation summaries
  - Runs before recentMessages (position: 95)
  - Includes recent session summaries
  - Shows topics and message counts

#### Actions

- **rememberAction**: Handles explicit memory requests
  - Triggers on keywords like "remember", "keep in mind", etc.
  - Uses LLM to extract what to remember
  - Categorizes and stores with confirmation

## How It Works

### Short-term Memory Flow

1. **Tracking**: MemoryService tracks message count per room
2. **Trigger**: When count reaches threshold (default: 50), summarizationEvaluator activates
3. **Summarization**: LLM generates comprehensive summary of conversation
4. **Archival**: Older messages deleted, summary stored, recent messages retained
5. **Context Injection**: shortTermMemoryProvider injects summaries in future conversations

### Long-term Memory Flow

1. **Monitoring**: longTermExtractionEvaluator runs periodically (every 10 messages)
2. **Analysis**: LLM analyzes conversation for facts worth remembering
3. **Extraction**: Identifies facts, categorizes them, assigns confidence
4. **Storage**: High-confidence facts stored in long_term_memories table
5. **Retrieval**: longTermMemoryProvider injects relevant facts in all future conversations

### Manual Memory Flow

1. **Detection**: User says "remember that..." or similar trigger phrase
2. **Validation**: rememberAction validates the request
3. **Extraction**: LLM extracts what to remember and categorizes it
4. **Storage**: Fact stored with 'manual' source and high confidence
5. **Confirmation**: Agent confirms what was stored

## Performance Optimization

### Context Reduction

- Without plugin: 1000 messages = ~200,000 tokens
- With plugin: 1000 messages = ~20 summaries + 10 recent = ~25,000 tokens
- **Savings**: ~85% reduction in context size

### Token Efficiency

- Summaries are 1/10th the size of original conversations
- Long-term memories provide rich context in minimal tokens
- Recent messages still available for immediate context

### Database Optimization

- Indexed queries for fast retrieval
- Separate tables for different memory types
- Optional vector search for semantic similarity (requires pgvector)

## Best Practices

### For Users

- Use explicit commands: "Remember that...", "Keep in mind...", "Don't forget..."
- Provide clear, factual information for better storage
- Verify important memories were stored correctly

### For Developers

- Adjust thresholds based on your use case
- Monitor summarization quality with test conversations
- Use confidence thresholds to filter low-quality extractions
- Consider enabling vector search for large-scale deployments

### Configuration Tips

- **High-frequency chatbots**: Lower threshold (30-40 messages)
- **Long-form conversations**: Higher threshold (60-100 messages)
- **Critical applications**: Higher confidence threshold (0.8-0.9)
- **Exploratory use**: Lower confidence threshold (0.6-0.7)

## Advanced Features

### Vector Search (Optional)

Enable semantic search for memories by:

1. Installing pgvector extension
2. Setting `MEMORY_VECTOR_SEARCH_ENABLED=true`
3. Generating embeddings for memories

### Memory Analytics

Use the `memory_access_logs` table to:

- Track which memories are most frequently accessed
- Identify useful vs. unused memories
- Optimize extraction strategies

### Custom Categories

Extend `LongTermMemoryCategory` enum for domain-specific categories:

```typescript
export enum CustomMemoryCategory {
  ...LongTermMemoryCategory,
  MEDICAL_HISTORY = 'medical_history',
  FINANCIAL_DATA = 'financial_data',
}
```

## Testing

Run the test suite:

```bash
cd packages/plugin-memory
bun test
```

## Troubleshooting

### Summaries not generating

- Check that message threshold is reached
- Verify MemoryService is registered
- Check LLM provider is configured

### Long-term memories not stored

- Verify `MEMORY_LONG_TERM_ENABLED=true`
- Check confidence threshold isn't too high
- Ensure facts are being extracted (check logs)

### High token usage

- Lower summarization threshold
- Reduce number of retained recent messages
- Limit number of long-term memories retrieved

## License

MIT

## Contributing

Contributions welcome! Please see the main ElizaOS contributing guide.
