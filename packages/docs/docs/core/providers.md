# 🔌 Providers

[Providers](/packages/core/src/providers.ts) are the sources of information for the agent. They provide data or state while acting as the agent's "senses", injecting real-time information into the agent's context. They serve as the eyes, ears, and other sensory inputs that allow the agent to perceive and interact with its environment, like a bridge between the agent and various external systems such as market data, wallet information, sentiment analysis, and temporal context. Anything that the agent knows is either coming from like the built-in context or from a provider. For more info, see the [providers API page](/api/interfaces/provider).

Here's an example of how providers work within ElizaOS:

- A news provider could fetch and format news.
- A computer terminal provider in a game could feed the agent information when the player is near a terminal.
- A wallet provider can provide the agent with the current assets in a wallet.
- A time provider injects the current date and time into the context.

---

## Overview

A provider's primary purpose is to supply dynamic contextual information that integrates with the agent's runtime. They format information for conversation templates and maintain consistent data access. For example:

- **Function:** Providers run during or before an action is executed.
- **Purpose:** They allow for fetching information from other APIs or services to provide different context or ways for an action to be performed.
- **Example:** Before a "Mars rover action" is executed, a provider could fetch information from another API. This fetched information can then be used to enrich the context of the Mars rover action.

The provider interface is defined in [types.ts](/packages/core/src/types.ts):

```typescript
interface Provider {
    get: (
        runtime: IAgentRuntime, // Which agent is calling the provider
        message: Memory,        // Last message received 
        state?: State          // Current conversation state
    ) => Promise<string>;      // Returns info to inject into context
}
```

The `get` function takes:
- `runtime`: The agent instance calling the provider
- `message`: The last message received 
- `state`: Current conversation state (optional)

It returns a string that gets injected into the agent's context. The function can return null if there is no reason to validate.


---

## Examples

ElizaOS providers typically fall into these categories, with examples from the ecosystem:

### System & Integration
- **Time Provider**: Injects current date/time for temporal awareness
- **Giphy Provider**: Provides GIF responses using Giphy API
- **GitBook Provider**: Supplies documentation context from GitBook
- **Topics Provider**: Caches and serves Allora Network topic information

### Blockchain & DeFi
- **Wallet Provider**: Portfolio data from Zerion, balances and prices
- **DePIN Provider**: Network metrics via DePINScan API
- **Chain Providers**: Data from Abstract, Fuel, ICP, EVM networks
- **Market Provider**: Token data from DexScreener, Birdeye APIs

### Knowledge & Data
- **DKG Provider**: OriginTrail decentralized knowledge integration
- **News Provider**: Current events via NewsAPI
- **Trust Provider**: Calculates and injects trust scores

Visit the [ElizaOS Plugin Registry](https://github.com/elizaos-plugins/registry) for a complete list of available plugins and providers.

### Time Provider
[Source: packages/plugin-bootstrap/src/providers/time.ts](/packages/plugin-bootstrap/src/providers/time.ts)

Provides temporal awareness by injecting current date/time information:

```typescript
const timeProvider: Provider = {
    get: async (_runtime: IAgentRuntime, _message: Memory) => {
        const currentDate = new Date();
        const options = {
            timeZone: "UTC",
            dateStyle: "full" as const,
            timeStyle: "long" as const
        };
        const humanReadable = new Intl.DateTimeFormat("en-US", options)
            .format(currentDate);
        return `The current date and time is ${humanReadable}. Please use this as your reference for any time-based operations or responses.`;
    }
};
```

### Facts Provider 
[Source: packages/plugin-bootstrap/src/providers/facts.ts](/packages/plugin-bootstrap/src/providers/facts.ts)

Manages and serves conversation facts and knowledge:

```typescript
const factsProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Get recent messages
        const recentMessagesData = state?.recentMessagesData?.slice(-10);
        const recentMessages = formatMessages({
            messages: recentMessagesData,
            actors: state?.actorsData
        });

        // Generate embedding for semantic search
        const embedding = await embed(runtime, recentMessages);
        
        const memoryManager = new MemoryManager({
            runtime,
            tableName: "facts"
        });

        // Retrieve relevant facts
        const facts = await memoryManager.getMemories({
            roomId: message.roomId,
            count: 10,
            agentId: runtime.agentId
        });

        if (facts.length === 0) return "";

        const formattedFacts = formatFacts(facts);
        return `Key facts that ${runtime.character.name} knows:\n${formattedFacts}`;
    }
};
```

### Boredom Provider
[Source: packages/plugin-bootstrap/src/providers/boredom.ts](/packages/plugin-bootstrap/src/providers/boredom.ts)

Manages conversation dynamics and engagement by calculating a "boredom score". The provider helps agents maintain appropriate conversation engagement levels by analyzing recent messages (last 15 minutes) and tracking conversational dynamics through keywords and pattern detection that then generates status messages reflecting interaction quality.

#### Scoring Mechanisms

**Increases Boredom**:
- Excessive punctuation
- Negative or dismissive language
- Repetitive conversation patterns

**Decreases Boredom**:
- Substantive discussion topics
- Engaging questions
- Research-related keywords

```typescript
// Sample scoring logic
if (interestWords.some((word) => messageText.includes(word))) {
    boredomScore -= 1;
}
```

---

## FAQ

### What's a good caching strategy for providers?
Cache expensive operations with an appropriate TTL based on data freshness requirements - for example, the Topics Provider uses 30-minute caching.

### How should providers handle missing data?
Return an empty string for missing or invalid data rather than null or undefined.

### What's the best way to format provider output?
Keep context strings concise and consistently formatted, using clear templates when possible.

### When should I use a provider vs a service?
Use a provider when you need to inject information into the agent's context, and a service when the functionality doesn't need to be part of the conversation.

### Can providers access service functionality?
Yes, providers can use services through the runtime. For example, a wallet provider might use a blockchain service to fetch data.

### How should providers handle failures?
Providers should handle failures gracefully and return an empty string or implement retries for external API calls. Never throw errors that would break the agent's context composition.

### Can providers maintain state?
While providers can maintain internal state, it's better to use the runtime's state management facilities for persistence.

---

## Further Reading

- [Provider Implementation](/packages/core/src/providers.ts)
- [Types Reference](/packages/core/src/types.ts)
- [Runtime Integration](/packages/core/src/runtime.ts)
