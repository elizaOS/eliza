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
- **Cognitive Science Based**: Organizes information into 3 core memory types (episodic, semantic, procedural)
- **Strict Criteria**: Only extracts truly significant, persistent information
- **Confidence Scoring**: Tracks reliability of stored information
- **Cross-session Persistence**: Remembers user context across all interactions

### 📊 Memory Categories (Based on Cognitive Science)

The plugin uses the three fundamental types of long-term memory from cognitive science:

1. **Episodic Memory**: Personal experiences and specific events
   - Example: "User completed migration from MongoDB to PostgreSQL in Q2 2024"
   - Contains: WHO did WHAT, WHEN/WHERE
   - Use for: Significant project milestones, important incidents, formative experiences

2. **Semantic Memory**: General facts, concepts, and knowledge
   - Example: "User is a senior TypeScript developer with 8 years experience"
   - Contains: Factual, timeless information
   - Use for: Professional identity, core expertise, established facts about work context

3. **Procedural Memory**: Skills, workflows, and how-to knowledge
   - Example: "User follows TDD workflow: writes tests first, then implementation"
   - Contains: HOW user does things
   - Use for: Consistent workflows, methodologies, debugging processes

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
MEMORY_SUMMARIZATION_THRESHOLD=16    # Messages before summarization starts (default: 16)
MEMORY_SUMMARIZATION_INTERVAL=10     # Update summary every N messages (default: 10)
MEMORY_RETAIN_RECENT=10             # Recent messages to keep (default: 10)
MEMORY_MAX_NEW_MESSAGES=20          # Max new messages in summary update (default: 20)

# Long-term Memory Settings
MEMORY_LONG_TERM_ENABLED=true       # Enable long-term extraction (default: true)
MEMORY_EXTRACTION_THRESHOLD=30      # Min messages before extraction starts (default: 30)
MEMORY_EXTRACTION_INTERVAL=10       # Run extraction every N messages (default: 10)
MEMORY_CONFIDENCE_THRESHOLD=0.85    # Minimum confidence to store (default: 0.85)
```

### Manual Memory Storage

Users can explicitly ask the agent to remember information:

```
User: "Remember that I prefer TypeScript over JavaScript"
Agent: I've made a note of that in my Semantic memory: "User prefers TypeScript over JavaScript"

User: "Keep in mind I'm working on a startup project"
Agent: I've made a note of that in my Episodic memory: "User is working on a startup project"

User: "Don't forget I always use TDD"
Agent: I've made a note of that in my Procedural memory: "User follows TDD (Test-Driven Development) methodology"
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
  category: LongTermMemoryCategory.SEMANTIC,
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

1. **Warm-up Period**: Extraction waits until 30+ messages (configurable) to ensure meaningful patterns
2. **Monitoring**: longTermExtractionEvaluator runs periodically (every 10 messages after threshold)
3. **Analysis**: LLM analyzes conversation for **persistent, important** facts worth remembering
4. **Strict Filtering**: Applies cognitive science principles to extract only truly significant information
5. **Storage**: High-confidence facts (≥0.85) stored in long_term_memories table
6. **Retrieval**: longTermMemoryProvider injects relevant facts in all future conversations

**Ultra-Strict Extraction Criteria**: The evaluator uses stringent criteria to prevent memory pollution:

- ✅ **DO Extract:**
  - **Episodic**: Significant milestones, important incidents, major decisions with lasting impact
  - **Semantic**: Professional identity, core expertise, established facts (explicitly stated or conclusively demonstrated)
  - **Procedural**: Consistent workflows (3+ occurrences or explicitly stated), standard practices, methodologies

- ❌ **NEVER Extract:**
  - One-time requests or tasks
  - Casual conversations without lasting significance
  - Exploratory questions or testing
  - Temporary context or situational information
  - Preferences from single occurrence
  - Social pleasantries
  - Common patterns everyone has
  - General knowledge not specific to user

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

**Short-term Memory:**
- **High-frequency chatbots**: Lower summarization threshold (10-15 messages)
- **Long-form conversations**: Higher threshold (20-30 messages)
- **Adjust retention**: Keep more recent messages for immediate context

**Long-term Memory:**
- **Conservative extraction**: Keep threshold at 30+ messages for better pattern recognition (default)
- **Aggressive extraction**: Lower threshold to 20 messages if needed (may reduce quality)
- **Balanced approach**: Default 0.85 confidence threshold ensures high-quality extractions
- **More permissive**: Lower confidence to 0.80 for more extractions (risk of lower quality)
- **Most strict**: Raise confidence to 0.90 for only the most certain facts
- **Frequent updates**: Lower extraction interval to 5-8 messages for faster learning
- **Conservative updates**: Keep default 10+ message interval to prevent over-extraction

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

The plugin uses three scientifically-grounded memory types from cognitive science. If you need additional categories for domain-specific use cases, you can extend the enum:

```typescript
export enum CustomMemoryCategory {
  ...LongTermMemoryCategory,
  MEDICAL_HISTORY = 'medical_history',
  FINANCIAL_DATA = 'financial_data',
}
```

**Note**: Consider carefully whether your custom category truly represents a different type of memory, or if it can be classified under episodic (events), semantic (facts), or procedural (how-to) memory.

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
