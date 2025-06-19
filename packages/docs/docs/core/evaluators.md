---
sidebar_position: 7
title: Evaluators System
description: Understanding ElizaOS evaluators - cognitive components that enable agents to learn and evolve
keywords: [evaluators, cognition, learning, memory, facts, reflection, analysis]
image: /img/evaluators.jpg
---

# 🧠 Evaluators

Evaluators are cognitive components in the ElizaOS framework that enable agents to process conversations, extract knowledge, and build understanding - similar to how humans form memories after interactions. They provide a structured way for agents to introspect, learn from interactions, and evolve over time.

## Understanding Evaluators

Evaluators are specialized functions that work with the [`AgentRuntime`](/api/classes/AgentRuntime) to analyze conversations after a response has been generated. Unlike actions that create responses, evaluators perform background cognitive tasks that enable numerous advanced capabilities:

- **Knowledge Building**: Automatically extract and store facts from conversations
- **Relationship Tracking**: Identify connections between entities
- **Conversation Quality**: Perform self-reflection on interaction quality
- **Goal Tracking**: Determine if conversation objectives are being met
- **Tone Analysis**: Evaluate emotional content and adjust future responses
- **User Profiling**: Build understanding of user preferences and needs over time
- **Performance Metrics**: Gather data on agent effectiveness and learn from interactions

### Core Structure

```typescript
import { Handler, Validator, EvaluationExample } from '@elizaos/core';

interface Evaluator {
  name: string; // Unique identifier
  similes?: string[]; // Alternative names/triggers
  description: string; // Purpose explanation
  examples: EvaluationExample[]; // Sample usage patterns
  handler: Handler; // Implementation logic
  validate: Validator; // Execution criteria check
  alwaysRun?: boolean; // Run regardless of validation
}
```

### Evaluator Execution Flow

The agent runtime executes evaluators as part of its cognitive cycle:

1. Agent processes a message and generates a response
2. Runtime calls `evaluate()` after response generation
3. Each evaluator's `validate()` method determines if it should run
4. For each valid evaluator, the `handler()` function is executed
5. Results are stored in memory and inform future responses

---

## Fact Evaluator: Memory Formation System

The Fact Evaluator serves as the agent's "episodic memory formation" system - similar to how humans process conversations and form memories. Just as you might reflect after a conversation "Oh, I learned something new about Sarah today", the Fact Evaluator systematically processes conversations to build up the agent's understanding of the world and the people in it.

### How It Works

#### 1. Triggering (The "When to Reflect" System)

```typescript
validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
  const messageCount = await runtime.messageManager.countMemories(message.roomId);
  const reflectionCount = Math.ceil(runtime.getConversationLength() / 2);
  return messageCount % reflectionCount === 0;
};
```

Just like humans don't consciously analyze every single word in real-time, the Fact Evaluator runs periodically rather than after every message. It triggers a "reflection" phase every few messages to process what's been learned.

#### 2. Fact Extraction (The "What Did I Learn?" System)

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

#### 3. Memory Deduplication (The "Is This New?" System)

```typescript
const filteredFacts = facts.filter((fact) => {
  return (
    !fact.already_known &&
    fact.type === 'fact' &&
    !fact.in_bio &&
    fact.claim &&
    fact.claim.trim() !== ''
  );
});
```

Just as humans don't need to consciously re-learn things they already know, the Fact Evaluator:

- Checks if information is already known
- Verifies if it's in the agent's existing knowledge (bio)
- Filters out duplicate or corrupted facts

#### 4. Memory Storage (The "Remember This" System)

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

### Example Processing

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

### Key Design Considerations

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

---

## Reflection Evaluator: Self-Awareness System

The reflection evaluator extends beyond fact extraction to enable agents to develop a form of "self-awareness" about their conversational performance. It allows agents to:

1. Generate self-reflective thoughts about the conversation quality
2. Extract factual information from conversations (similar to the Fact Evaluator)
3. Identify and track relationships between entities

### How Reflections Work

When triggered, the reflection evaluator:

1. Analyzes recent conversations and existing knowledge
2. Generates structured reflection output with:
   - Self-reflective thoughts about conversation quality
   - New facts extracted from conversation
   - Identified relationships between entities
3. Stores this information in the agent's memory for future reference

### Example Reflection Output

```json
{
  "thought": "I'm engaging appropriately with John, maintaining a welcoming and professional tone. My questions are helping learn more about him as a new community member.",
  "facts": [
    {
      "claim": "John is new to the community",
      "type": "fact",
      "in_bio": false,
      "already_known": false
    },
    {
      "claim": "John found the community through a friend interested in AI",
      "type": "fact",
      "in_bio": false,
      "already_known": false
    }
  ],
  "relationships": [
    {
      "sourceEntityId": "sarah-agent",
      "targetEntityId": "user-123",
      "tags": ["group_interaction"]
    },
    {
      "sourceEntityId": "user-123",
      "targetEntityId": "sarah-agent",
      "tags": ["group_interaction"]
    }
  ]
}
```

### Implementation Details

The reflection evaluator uses a defined schema to ensure consistent output:

```typescript
const reflectionSchema = z.object({
  facts: z.array(
    z.object({
      claim: z.string(),
      type: z.string(),
      in_bio: z.boolean(),
      already_known: z.boolean(),
    })
  ),
  relationships: z.array(relationshipSchema),
});

const relationshipSchema = z.object({
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  tags: z.array(z.string()),
  metadata: z
    .object({
      interactions: z.number(),
    })
    .optional(),
});
```

### Validation Logic

The reflection evaluator includes validation logic that determines when reflection should occur:

```typescript
validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
  const lastMessageId = await runtime.getCache<string>(
    `${message.roomId}-reflection-last-processed`
  );
  const messages = await runtime.getMemories({
    tableName: 'messages',
    roomId: message.roomId,
    count: runtime.getConversationLength(),
  });

  if (lastMessageId) {
    const lastMessageIndex = messages.findIndex((msg) => msg.id === lastMessageId);
    if (lastMessageIndex !== -1) {
      messages.splice(0, lastMessageIndex + 1);
    }
  }

  const reflectionInterval = Math.ceil(runtime.getConversationLength() / 4);

  return messages.length > reflectionInterval;
};
```

This ensures reflections occur at appropriate intervals, typically after a set number of messages have been exchanged.

## Common Memory Formation Patterns

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
   'Works at tech startup';
   'Startup is in Seattle';

   // Inference potential
   'Works in Seattle tech industry';
   ```

3. **Temporal Tracking**

   ```typescript
   // Status tracking
   t0: 'Looking for a job'(status);
   t1: 'Got a new job'(fact);
   t2: 'Been at job for 3 months'(status);
   ```

4. **Relationship Building**

   ```typescript
   // Initial relationship
   {
     "sourceEntityId": "user-123",
     "targetEntityId": "sarah-agent",
     "tags": ["new_interaction"]
   }

   // Evolving relationship
   {
     "sourceEntityId": "user-123",
     "targetEntityId": "sarah-agent",
     "tags": ["frequent_interaction", "positive_sentiment"],
     "metadata": { "interactions": 15 }
   }
   ```

## Integration with Other Systems

Evaluators work alongside other components:

- **Goal Evaluator**: Facts and reflections may influence goal progress
- **Trust Evaluator**: Fact consistency affects trust scoring
- **Memory Manager**: Facts enhance context for future conversations
- **Providers**: Facts inform response generation

---

## Creating Custom Evaluators

You can create your own evaluators by implementing the `Evaluator` interface:

```typescript
import { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';

const customEvaluator: Evaluator = {
  name: 'CUSTOM_EVALUATOR',
  similes: ['ANALYZE', 'ASSESS'],
  description: 'Performs custom analysis on conversations',

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Your validation logic here
    return true;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Your evaluation logic here

    // Example of storing evaluation results
    await runtime.addEmbeddingToMemory({
      entityId: runtime.agentId,
      content: { text: 'Evaluation result' },
      roomId: message.roomId,
      createdAt: Date.now(),
    });

    return { result: 'evaluation complete' };
  },

  examples: [
    {
      prompt: `Example context`,
      messages: [
        { name: 'User', content: { text: 'Example message' } },
        { name: 'Agent', content: { text: 'Example response' } },
      ],
      outcome: `{ "result": "example outcome" }`,
    },
  ],
};
```

### Registering Custom Evaluators

Custom evaluators can be registered with the agent runtime:

```typescript
// In your plugin's initialization
export default {
  name: 'custom-evaluator-plugin',
  description: 'Adds custom evaluation capabilities',

  init: async (config: any, runtime: IAgentRuntime) => {
    // Register your custom evaluator
    runtime.registerEvaluator(customEvaluator);
  },

  // Include the evaluator in the plugin exports
  evaluators: [customEvaluator],
};
```

## Best Practices for Memory Formation

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

5. **Balance Reflection Frequency**
   - Too frequent: Computational overhead
   - Too infrequent: Missing important information
   - Adapt based on conversation complexity and pace

---

## FAQ

### What's the difference between actions and evaluators?

Actions are triggered during response generation and create visible outputs, while evaluators run after responses and perform background cognitive tasks without direct user visibility.

### When should I use the Fact Evaluator vs. the Reflection Evaluator?

Use the Fact Evaluator when you only need to extract and store factual information. Use the Reflection Evaluator when you need both fact extraction and relationship tracking, along with self-reflective assessment.

### How often do evaluators run?

By default, evaluators run at intervals based on conversation length, typically after every few messages, to avoid unnecessary processing while still capturing important information.

### Can evaluators affect future responses?

Yes! Facts and relationships stored by evaluators become part of the agent's memory and context, influencing future responses through the retrieval-augmented generation system.

### How do I debug evaluator issues?

Use the logger to inspect evaluator execution and output. The most common issues involve entity resolution failures or schema validation errors.

### Can evaluators work across different platforms?

Yes, evaluators are platform-agnostic and work the same way regardless of whether your agent is deployed on Discord, Twitter, Telegram, or web interfaces.

## Related Resources

- [Actions Documentation](./actions.md)
- [Providers Documentation](./providers.md)
- [Agent Runtime](./agents.md)
