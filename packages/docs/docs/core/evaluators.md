---
sidebar_position: 5
---

# 📊 Evaluators

[Evaluators](/api/interfaces/evaluator) are core components that assess and extract information from conversations. Agents use evaluators to automatically process conversations after they happen to help build up their knowledge and understanding over time.

They integrate with the [`AgentRuntime`](/api/classes/AgentRuntime) evaluation system to enable reflection, fact-gathering, and behavioral adaptation and run after each agent action to help maintain contextual awareness. Enabling agents to reflect on their actions and world state is crucial for improving coherence and problem-solving abilities. For example, by reflecting on its performance, an agent can refine its strategies and improve its interactions over time.

---

## How They Work

Evaluators run automatically after each agent action (responses, messages, activities, or API calls) to analyze what happened and update the agent's understanding. They extract important information (like facts about users), track progress on goals, build relationship models, and enable self-reflection.

Let's say you're at a party and meet someone new. During the conversation:

- You learn their name is Sarah
- They mention living in Seattle
- They work as a software engineer

After the conversation, your brain:

- Stores these facts for later
- Updates your understanding of who Sarah is
- Might note "I should connect Sarah with Bob who's also in tech"
- Reflects on how the interaction went (e.g., "I think I talked too much about work")

This is exactly how evaluators work for agents. They run in the background to extract insights, track progress, build relationship models, and enable self-reflection. Evaluators are limited to processing current interactions (can't modify past data) and run after actions complete (not during), so they're best for analysis rather than critical operations.

The key thing to remember is: evaluators are your agent's way of learning, reflecting, and growing from each interaction, just like how we naturally process and learn from our conversations.

### Common Uses

- **[Reflection Evaluator](https://github.com/elizaOS/eliza/blob/main/packages/core/src/evaluators/reflection.ts)**: Combines self-monologue, fact extraction, and relationship building
- **[Fact Evaluator](https://github.com/elizaOS/eliza/blob/main/packages/plugin-bootstrap/src/evaluators/fact.ts)**: Learns and remembers facts about users
- **[Goal Evaluator](https://github.com/elizaOS/eliza/blob/main/packages/plugin-bootstrap/src/evaluators/goals.ts)**: Tracks progress on objectives
- **Trust Evaluator**: Builds understanding of relationships
- **Sentiment Evaluator**: Tracks emotional tone of conversations

---

## Implementation

Here's a basic example of an evaluator implementation:

```typescript
const evaluator = {
  // Should this evaluator run right now?
  validate: async (runtime, message) => {
    // Return true to run, false to skip
    return shouldRunThisTime;
  },

  // What to do when it runs
  handler: async (runtime, message) => {
    // Extract info, update memory, etc
    const newInfo = extractFromMessage(message);
    await storeInMemory(newInfo);
  },
};
```

### Core Interface

```typescript
interface Evaluator {
  name: string; // Unique identifier
  similes: string[]; // Similar evaluator descriptions
  description: string; // Purpose and functionality
  validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
  handler: (runtime: IAgentRuntime, message: Memory) => Promise<any>;
  examples: EvaluatorExample[];
}
```

For full type definitions, see the [`Evaluator`](/api/interfaces/Evaluator) interface documentation.

### Validation Function

The `validate` function is critical for determining when an evaluator should run. For peak performance, proper validation ensures evaluators run only when necessary. For instance, a customer service agent might check if all required user data has been collected and only run if data is still missing.

```typescript
validate: async (runtime: IAgentRuntime, message: Memory) => boolean;
```

Determines if evaluator should run for current message. Returns true to execute handler, false to skip. Should be efficient and quick to check.

### Handler Function

The handler function contains the evaluator's code. It is where the logic for analyzing data, extracting information, and triggering actions resides.

```typescript
handler: async (runtime: IAgentRuntime, message: Memory) => any;
```

Contains main evaluation logic and runs when validate() returns true. Can access [`runtime`](/api/interfaces/IAgentRuntime) services and [`memory`](/api/interfaces/Memory).

:::tip
**Ensure Evaluators are unique and lightweight**

Avoid complex operations or lengthy computations within the evaluator's handler function and ensure that evaluators have clear and distinct responsibilities not already handled by other components for peak performance.
:::

### Memory Integration

Results are stored using runtime memory managers:

```typescript
// Example storing evaluation results
const memory = await runtime.addEmbeddingToMemory({
  entityId: message.entityId,
  agentId: message.agentId,
  content: { text: evaluationResult },
  roomId: message.roomId,
  embedding: await runtime.useModel(ModelType.TEXT_EMBEDDING, { text: evaluationResult }),
});

await runtime.createMemory(memory, 'facts', true);
```

---

## Reflection Evaluator

The Reflection Evaluator is a comprehensive evaluator that combines multiple functions:

1. **Self-Monologue**: Generates introspective thoughts about the agent's performance
2. **Fact Extraction**: Identifies and stores new factual information
3. **Relationship Building**: Maps connections between entities in the conversation

The reflection evaluator runs periodically during conversations (by default, every quarter of the conversation length) and performs a deep analysis of the entire context.

### Reflection Output Structure

Reflections are structured with three main components:

```typescript
interface Reflection {
  thought: string; // Self-reflective monologue
  facts: {
    claim: string; // Factual statement
    type: 'fact' | 'opinion' | 'status'; // Classification
    in_bio: boolean; // Already in agent knowledge
    already_known: boolean; // Previously extracted
  }[];
  relationships: {
    sourceEntityId: UUID; // Entity initiating interaction
    targetEntityId: UUID; // Entity being interacted with
    tags: string[]; // Relationship classifiers
  }[];
}
```

### Example Reflection

Here's an example of a reflection from a community manager agent:

```json
{
  "thought": "I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome.",
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

In this reflection:

- The agent validates it's using appropriate communication strategies
- Two new facts are identified about John
- Two relationship connections are established (bidirectional between agent and user)

### Self-Awareness Through Reflection

The thought component helps agents develop self-awareness. For example, if an agent is dominating a conversation:

```json
{
  "thought": "I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate."
}
```

This self-awareness allows agents to adjust their behavior in future interactions, creating more natural and balanced conversations.

### Integration with Providers

Facts extracted by evaluators are stored in memory and can be accessed by providers like the `factsProvider`. This creates a virtuous cycle:

1. Evaluators extract and store facts after conversations
2. The facts provider retrieves relevant facts during future conversations
3. The agent uses these facts to provide more contextually relevant responses
4. New facts are identified and stored by evaluators

## Fact Evaluator

The Fact Evaluator is a specialized evaluator focused on extracting meaningful facts from conversations. It processes interactions to:

- Extract meaningful facts and opinions about users and the world
- Distinguish between permanent facts, opinions, and status
- Track what information is already known vs new information
- Build up the agent's understanding over time through embeddings and memory storage

Facts are stored with the following structure:

```typescript
interface Fact {
  claim: string; // The actual information extracted
  type: 'fact' | 'opinion' | 'status'; // Classification of the information
  in_bio: boolean; // Whether this info is already in the agent's knowledge
  already_known: boolean; // Whether this was previously extracted
}
```

#### Example Facts

Here's an example of extracted facts from a conversation:

```
User: I finally finished my marathon training program!
Agent: That's a huge accomplishment! How do you feel about it?
User: I'm really proud of what I achieved. It was tough but worth it.
Agent: What's next for you?
User: I'm actually training for a triathlon now. It's a whole new challenge.
```

```typescript
const extractedFacts = [
  {
    claim: 'User completed marathon training',
    type: 'fact', // Permanent info / achievement
    in_bio: false,
    already_known: false, // Prevents duplicate storage
  },
  {
    claim: 'User feels proud of their achievement',
    type: 'opinion', // Subjective views or feelings
    in_bio: false,
    already_known: false,
  },
  {
    claim: 'User is currently training for a triathlon',
    type: 'status', // Ongoing activity, changeable
    in_bio: false,
    already_known: false,
  },
];
```

## Goal Evaluator

The Goal Evaluator tracks progress on conversation objectives by analyzing messages and updating goal status. Goals are structured like this:

```typescript
interface Goal {
  id: string;
  name: string;
  status: 'IN_PROGRESS' | 'DONE' | 'FAILED';
  objectives: {
    description: string;
    completed: boolean;
  }[];
}
```

#### Example Goals

Here's how the goal evaluator processes a conversation:

```typescript
// Initial goal state
const goal = {
  id: 'book-club-123',
  name: 'Complete reading assignment',
  status: 'IN_PROGRESS',
  objectives: [
    { description: 'Read chapters 1-3', completed: false },
    { description: 'Take chapter notes', completed: false },
    { description: 'Share thoughts in book club', completed: false },
  ],
};

// Conversation happens
const conversation = `
User: I finished reading the first three chapters last night
Agent: Great! Did you take any notes while reading?
User: Yes, I made detailed notes about the main characters
Agent: Perfect, we can discuss those in the club meeting
User: I'm looking forward to sharing my thoughts tomorrow
`;

// Goal evaluator updates the goal status
const updatedGoal = {
  id: 'book-club-123',
  name: 'Complete reading assignment',
  status: 'IN_PROGRESS', // Still in progress
  objectives: [
    { description: 'Read chapters 1-3', completed: true }, // Marked complete
    { description: 'Take chapter notes', completed: true }, // Marked complete
    { description: 'Share thoughts in book club', completed: false }, // Still pending
  ],
};

// After the book club meeting, goal would be marked DONE
// If user can't complete objectives, goal could be marked FAILED
```

---

## FAQ

### How do evaluators differ from providers?

While [providers](/api/interfaces/Provider) supply data to the agent before responses, evaluators analyze conversations after responses. Providers inform decisions, evaluators learn from outcomes.

### Can evaluators modify agent behavior?

Evaluators cannot directly modify agent responses. However, through their extracted facts and self-reflections that are stored in memory, they indirectly influence future behavior by shaping the agent's knowledge and self-awareness.

### How many evaluators can run simultaneously?

There's no hard limit, but each evaluator adds processing overhead. Focus on essential evaluations and use efficient validation to optimize performance. The reflection evaluator can replace multiple specialized evaluators since it combines fact extraction, relationship building, and self-reflection.

### How does the reflection evaluator determine when to run?

The reflection evaluator typically runs at regular intervals during a conversation (e.g., every quarter of the conversation length). This balances the need for regular reflection with performance considerations.

### How do facts extracted by evaluators get used?

Facts are stored in the agent's memory with embeddings for semantic retrieval. The facts provider can retrieve relevant facts during conversations using semantic search, allowing the agent to remember and use this information in responses.

### What's the difference between 'facts', 'opinions', and 'status'?

- **Facts**: Permanent truths about entities (e.g., "John lives in Seattle")
- **Opinions**: Subjective views or feelings (e.g., "John feels proud of his achievement")
- **Status**: Temporary states that change over time (e.g., "John is currently traveling")

### Can evaluators communicate with each other?

Evaluators don't directly communicate but can share data through the memory system. The reflection evaluator often combines the functionality of multiple evaluators, reducing the need for inter-evaluator communication.

### How are self-reflections used by agents?

Self-reflections help agents become more self-aware and improve their interaction quality. For example, if an agent reflects that it's dominating a conversation, it can adjust its behavior in future interactions to create more balance.

### What's the difference between similes and examples in evaluators?

Similes provide alternative descriptions of the evaluator's purpose, while examples show concrete scenarios with inputs and expected outcomes. Examples help verify correct implementation.

### Can evaluators be conditionally enabled?

Yes, use the validation function to control when evaluators run. This can be based on message content, user status, conversation length, or other runtime conditions.

```

```
