# Fact Evaluator: Memory Formation System

The Fact Evaluator serves as the agent's "episodic memory formation" system - similar to how humans process conversations and form memories. Just as you might reflect after a conversation "Oh, I learned something new about Sarah today", the Fact Evaluator systematically processes conversations to build up the agent's understanding of the world and the people in it.

## How It Works

### 1. Triggering (The "When to Reflect" System)
```typescript
validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const messageCount = await runtime.messageManager.countMemories(message.roomId);
    const reflectionCount = Math.ceil(runtime.getConversationLength() / 2);
    return messageCount % reflectionCount === 0;
}
```
Just like humans don't consciously analyze every single word in real-time, the Fact Evaluator runs periodically rather than after every message. It triggers a "reflection" phase every few messages to process what's been learned.

### 2. Fact Extraction (The "What Did I Learn?" System)
The evaluator uses a template-based approach to extract three types of information:

- **Facts**: Unchanging truths about the world or people
  - "Bob lives in New York"
  - "Sarah has a degree in Computer Science"
  
- **Status**: Temporary or changeable states
  - "Bob is currently working on a new project"
  - "Sarah is visiting Paris this week"
  
- **Opinions**: Subjective views, feelings, or non-factual statements
  - "Bob thinks the project will be successful"
  - "Sarah loves French cuisine"

### 3. Memory Deduplication (The "Is This New?" System)
```typescript
const filteredFacts = facts.filter((fact) => {
    return (
        !fact.already_known &&
        fact.type === "fact" &&
        !fact.in_bio &&
        fact.claim &&
        fact.claim.trim() !== ""
    );
});
```
Just as humans don't need to consciously re-learn things they already know, the Fact Evaluator:
- Checks if information is already known
- Verifies if it's in the agent's existing knowledge (bio)
- Filters out duplicate or corrupted facts

### 4. Memory Storage (The "Remember This" System)
```typescript
const factMemory = await factsManager.addEmbeddingToMemory({
    userId: agentId!,
    agentId,
    content: { text: fact },
    roomId,
    createdAt: Date.now(),
});
```
Facts are stored with embeddings to enable:
- Semantic search of related facts
- Context-aware recall
- Temporal tracking (when the fact was learned)

## Example Processing

Given this conversation:
```
User: "I just moved to Seattle last month!"
Agent: "How are you finding the weather there?"
User: "It's rainy, but I love my new job at the tech startup"
```

The Fact Evaluator might extract:
```json
[
  {
    "claim": "User moved to Seattle last month",
    "type": "fact",
    "in_bio": false,
    "already_known": false
  },
  {
    "claim": "User works at a tech startup",
    "type": "fact",
    "in_bio": false,
    "already_known": false
  },
  {
    "claim": "User enjoys their new job",
    "type": "opinion",
    "in_bio": false,
    "already_known": false
  }
]
```

## Key Design Considerations

1. **Episodic vs Semantic Memory**
   - Facts build up the agent's semantic memory (general knowledge)
   - The raw conversation remains in episodic memory (specific experiences)

2. **Temporal Awareness**
   - Facts are timestamped to track when they were learned
   - Status facts can be updated as they change

3. **Confidence and Verification**
   - Multiple mentions of a fact increase confidence
   - Contradictory facts can be flagged for verification

4. **Privacy and Relevance**
   - Only stores relevant, conversation-appropriate facts
   - Respects explicit and implicit privacy boundaries

## Integration with Other Systems

The Fact Evaluator works alongside other evaluators and systems:

- **Goal Evaluator**: Facts may influence goal progress
- **Trust Evaluator**: Fact consistency affects trust scoring
- **Memory Manager**: Facts enhance context for future conversations
- **Providers**: Facts inform response generation

## Common Patterns

1. **Progressive Learning**
   ```typescript
   // First conversation
   "I live in Seattle" -> Stores as fact
   
   // Later conversation
   "I live in the Ballard neighborhood" -> Updates/enhances existing fact
   ```

2. **Fact Chaining**
   ```typescript
   // Original facts
   "Works at tech startup"
   "Startup is in Seattle"
   
   // Inference potential
   "Works in Seattle tech industry"
   ```

3. **Temporal Tracking**
   ```typescript
   // Status tracking
   t0: "Looking for a job" (status)
   t1: "Got a new job" (fact)
   t2: "Been at job for 3 months" (status)
   ```

## Best Practices

1. **Validate Facts**
   - Cross-reference with existing knowledge
   - Consider source reliability
   - Track fact confidence levels

2. **Manage Memory Growth**
   - Prioritize important facts
   - Consolidate related facts
   - Archive outdated status facts

3. **Handle Contradictions**
   - Flag conflicting facts
   - Maintain fact history
   - Update based on newest information

4. **Respect Privacy**
   - Filter sensitive information
   - Consider contextual appropriateness
   - Follow data retention policies
