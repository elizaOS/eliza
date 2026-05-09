---
description: Eva
globs:
alwaysApply: false
---

# ElizaOS Evaluators System

Evaluators are cognitive components that enable agents to process conversations, extract knowledge, and build understanding by reflecting on the action chain. They run after the actions are processed, and are there to guaranteeably run after everything else runs. A good use of an evaluator is to determine and extract new facts about someone we're talking to. It's very similar to an action, but doesn't chain, and always runs without being selected. Evaluators can enable agents to perform background analysis after responses are generated, similar to how humans form memories after interactions. This is very similar to the concept of reflection from the "Reflexion" paper.

## Core Concepts

### Evaluator Structure

```typescript
interface Evaluator {
  name: string; // Unique identifier
  similes?: string[]; // Alternative names
  description: string; // Purpose explanation
  examples: EvaluationExample[]; // Sample patterns
  handler: Handler; // Implementation logic
  validate: Validator; // Execution criteria
  alwaysRun?: boolean; // Run regardless of validation
}
```

### Execution Flow

1. Agent processes message and generates response
2. Runtime calls `evaluate()` after response
3. Each evaluator's `validate()` checks if it should run
4. Valid evaluators execute via `handler()`
5. Results stored in memory for future use

## Key Evaluators

### Fact Evaluator

Extracts and stores factual information from conversations:

```typescript
const factEvaluator: Evaluator = {
  name: 'EXTRACT_FACTS',

  validate: async (runtime, message) => {
    // Run periodically, not every message
    const messageCount = await runtime.countMemories(message.roomId);
    const interval = Math.ceil(runtime.getConversationLength() / 2);
    return messageCount % interval === 0;
  },

  handler: async (runtime, message, state) => {
    // Extract facts using LLM
    const facts = await extractFacts(state);

    // Filter and deduplicate
    const newFacts = facts.filter(
      (fact) => !fact.already_known && fact.type === 'fact' && fact.claim?.trim()
    );

    // Store as embeddings
    for (const fact of newFacts) {
      await runtime.addEmbeddingToMemory({
        content: { text: fact.claim },
        entityId: message.entityId,
        roomId: message.roomId,
      });
    }
  },
};
```

### Reflection Evaluator

Enables self-awareness and relationship tracking:

```typescript
const reflectionEvaluator: Evaluator = {
  name: 'REFLECT',

  handler: async (runtime, message, state) => {
    const reflection = await generateReflection(state);

    // Extract components
    const { thought, facts, relationships } = reflection;

    // Store self-reflection
    if (thought) {
      await runtime.createMemory({
        content: { text: thought, type: 'reflection' },
        entityId: runtime.agentId,
        roomId: message.roomId,
      });
    }

    // Create relationships
    for (const rel of relationships) {
      await runtime.createRelationship({
        sourceEntityId: rel.sourceEntityId,
        targetEntityId: rel.targetEntityId,
        tags: rel.tags,
      });
    }
  },
};
```

## Memory Formation Patterns

### Episodic vs Semantic

- **Episodic**: Raw conversation history (specific experiences)
- **Semantic**: Extracted facts and knowledge (general understanding)
- Facts build semantic memory from episodic experiences

### Progressive Learning

```typescript
// First encounter
"I work at TechCorp" → Store: {entity: "user", employer: "TechCorp"}

// Later conversation
"I'm a senior engineer at TechCorp" → Update: {role: "senior engineer"}

// Builds complete picture over time
```

### Relationship Evolution

```typescript
// Initial interaction
{ tags: ["new_interaction"] }

// After multiple conversations
{
  tags: ["frequent_interaction", "positive_sentiment"],
  metadata: { interactions: 15, trust_level: "high" }
}
```

## Implementation Patterns

### Custom Evaluator

```typescript
const customEvaluator: Evaluator = {
  name: 'CUSTOM_ANALYSIS',
  description: 'Analyzes specific patterns',

  validate: async (runtime, message, state) => {
    // Check if evaluation needed
    return message.content.text?.includes('analyze');
  },

  handler: async (runtime, message, state) => {
    // Perform analysis
    const analysis = await analyzePattern(state);

    // Store results
    await runtime.addEmbeddingToMemory({
      entityId: runtime.agentId,
      content: {
        text: `Analysis: ${analysis.summary}`,
        metadata: analysis,
      },
      roomId: message.roomId,
    });

    return { success: true };
  },

  examples: [
    {
      prompt: 'Conversation with analysis request',
      messages: [
        { name: 'User', content: { text: 'Can you analyze this data?' } },
        { name: 'Agent', content: { text: "I'll analyze that for you." } },
      ],
      outcome: 'Analysis stored in memory',
    },
  ],
};
```

## Best Practices

1. **Validation Efficiency**: Keep validation checks lightweight
2. **Periodic Execution**: Don't run on every message
3. **Fact Verification**: Cross-reference with existing knowledge
4. **Memory Management**: Prioritize important information
5. **Privacy Respect**: Filter sensitive information
6. **Error Handling**: Continue gracefully on failures

## Integration with System

### With Actions

- Actions create responses → Evaluators analyze them
- Evaluators store insights → Actions use in future

### With Providers

- Providers supply context → Evaluators process it
- Evaluators create facts → Fact provider serves them

### With Memory

- Evaluators create embeddings for semantic search
- Facts enhance future context retrieval
- Relationships improve entity resolution

## Common Evaluator Types

- **FACT_EXTRACTOR**: Extracts factual claims
- **REFLECTION**: Self-assessment and improvement
- **GOAL_TRACKER**: Monitors conversation objectives
- **TRUST_EVALUATOR**: Assesses interaction quality
- **TOPIC_ANALYZER**: Identifies conversation themes
- **SENTIMENT_ANALYZER**: Tracks emotional context

## Plugin Registration

```typescript
const myPlugin: Plugin = {
  name: 'my-plugin',
  evaluators: [factEvaluator, reflectionEvaluator, customEvaluator],

  init: async (runtime) => {
    // Evaluators automatically registered
  },
};
```
