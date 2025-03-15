---
sidebar_position: 5
---

# 📊 Evaluators

[Evaluators](/api/interfaces/evaluator) are core components that assess and extract information from conversations. Agents use evaluators to automatically process conversations after they happen to help build up their knowledge and understanding over time.


They integrate with the [`AgentRuntime`](/api/classes/AgentRuntime) evaluation system to enable reflection, fact-gathering, and behavioral adaptation and run after each agent action to help maintain contextural awareness. Enabling agents to reflect on their actions and world state is crucial for improving coherence and problem-solving abilities. For example, by reflecting on its performance, an agent can refine its strategies and improve its interactions over time.

---

## How They Work

Evaluators run automatically after each agent action (responses, messages, activities, or API calls) to analyze what happened and update the agent's understanding. They extract important information (like facts about users), track progress on goals, and learn from interactions.

Let's say you're at a party and meet someone new. During the conversation:
- You learn their name is Sarah
- They mention living in Seattle 
- They work as a software engineer

After the conversation, your brain:
- Stores these facts for later
- Updates your understanding of who Sarah is
- Might note "I should connect Sarah with Bob who's also in tech"

This is exactly how evaluators work for agents - they run in the background to extract insights, track progress, and build up the agent's knowledge over time. However there are some limitations, such as evaluators only process current interactions (can't modify past data), they run after actions complete (not during). Therefore evaluators are best for analysis rather than critical operations.

The key thing to remember is: evaluators are your agent's way of learning and growing from each interaction, just like how we naturally process and learn from our conversations.

### Common Uses

- **[Fact Evaluator](https://github.com/elizaOS/eliza/blob/main/packages/plugin-bootstrap/src/evaluators/fact.ts)**: Learns and remembers facts about users
- **[Goal Evaluator](https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/main/packages/plugin-bootstrap/src/evaluators/goal.ts)**: Tracks progress on objectives
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
    }
};
```

### Core Interface

```typescript
interface Evaluator {
    name: string;                // Unique identifier
    similes: string[];          // Similar evaluator descriptions
    description: string;        // Purpose and functionality
    validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
    handler: (runtime: IAgentRuntime, message: Memory) => Promise<any>;
    examples: EvaluatorExample[];
}
```

For full type definitions, see the [`Evaluator`](/api/interfaces/Evaluator) interface documentation.

### Validation Function

The `validate` function is critical for determining when an evaluator should run. For peak performance, proper validation ensures evaluators run only when necessary. For instance, a customer service agent might check if all required user data has been collected and only run if data is still missing.

```typescript
validate: async (runtime: IAgentRuntime, message: Memory) => boolean
```
Determines if evaluator should run for current message. Returns true to execute handler, false to skip. Should be efficient and quick to check.

### Handler Function

The handler function contains the evaluator's code. It is where the logic for analyzing data, extracting information, and triggering actions resides.

```typescript
handler: async (runtime: IAgentRuntime, message: Memory) => any
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
const memory = await runtime.memoryManager.addEmbeddingToMemory({
    userId: user?.id,
    content: { text: evaluationResult },
    roomId: roomId,
    embedding: await embed(runtime, evaluationResult)
});

await runtime.memoryManager.createMemory(memory);
```


---

## Fact Evaluator


:::info Deep Dive
For a comprehensive guide on how the fact evaluator system works, including implementation details and best practices, check out our [Fact Evaluator Guide](fact-evaluator.md).
:::

The Fact Evaluator is one of the most powerful built-in evaluators. It processes convos to:
- Extract meaningful facts and opinions about users and the world
- Distinguish between permanent facts, opinions, and status
- Track what information is already known vs new information 
- Build up the agent's understanding over time through embeddings and memory storage

Facts are stored with the following structure:

```typescript
interface Fact {
    claim: string;      // The actual information extracted
    type: "fact" | "opinion" | "status";  // Classification of the information
    in_bio: boolean;    // Whether this info is already in the agent's knowledge
    already_known: boolean;  // Whether this was previously extracted
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
        "claim": "User completed marathon training",
        "type": "fact",          // Permanent info / achievement
        "in_bio": false,
        "already_known": false   // Prevents duplicate storage
    },
    {
        "claim": "User feels proud of their achievement",
        "type": "opinion",       // Subjective views or feelings
        "in_bio": false,
        "already_known": false
    },
    {
        "claim": "User is currently training for a triathlon",
        "type": "status",        // Ongoing activity, changeable
        "in_bio": false,
        "already_known": false
    }
];
```


<details>
<summary>View Full Fact Evaluator Implementation</summary>

```typescript
import { composeContext } from "@elizaos/core";
import { generateObjectArray } from "@elizaos/core";
import { MemoryManager } from "@elizaos/core";
import {
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type Evaluator,
} from "@elizaos/core";

export const formatFacts = (facts: Memory[]) => {
    const messageStrings = facts
        .reverse()
        .map((fact: Memory) => fact.content.text);
    const finalMessageStrings = messageStrings.join("\n");
    return finalMessageStrings;
};

const factsTemplate =
    // {{actors}}
    `TASK: Extract Claims from the conversation as an array of claims in JSON format.

# START OF EXAMPLES
These are examples of the expected output of this task:
{{evaluationExamples}}
# END OF EXAMPLES

# INSTRUCTIONS

Extract any claims from the conversation that are not already present in the list of known facts above:
- Try not to include already-known facts. If you think a fact is already known, but you're not sure, respond with already_known: true.
- If the fact is already in the user's description, set in_bio to true
- If we've already extracted this fact, set already_known to true
- Set the claim type to 'status', 'fact' or 'opinion'
- For true facts about the world or the character that do not change, set the claim type to 'fact'
- For facts that are true but change over time, set the claim type to 'status'
- For non-facts, set the type to 'opinion'
- 'opinion' includes non-factual opinions and also includes the character's thoughts, feelings, judgments or recommendations
- Include any factual detail, including where the user lives, works, or goes to school, what they do for a living, their hobbies, and any other relevant information

Recent Messages:
{{recentMessages}}

Response should be a JSON object array inside a JSON markdown block. Correct response format:
\`\`\`json
[
  {"claim": string, "type": enum<fact|opinion|status>, in_bio: boolean, already_known: boolean },
  {"claim": string, "type": enum<fact|opinion|status>, in_bio: boolean, already_known: boolean },
  ...
]
\`\`\``;

async function handler(runtime: IAgentRuntime, message: Memory) {
    const state = await runtime.composeState(message);

    const { agentId, roomId } = state;

    const context = composeContext({
        state,
        template: runtime.character.templates?.factsTemplate || factsTemplate,
    });

    const facts = await generateObjectArray({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
    });

    const factsManager = new MemoryManager({
        runtime,
        tableName: "facts",
    });

    if (!facts) {
        return [];
    }

    // If the fact is known or corrupted, remove it
    const filteredFacts = facts
        .filter((fact) => {
            return (
                !fact.already_known &&
                fact.type === "fact" &&
                !fact.in_bio &&
                fact.claim &&
                fact.claim.trim() !== ""
            );
        })
        .map((fact) => fact.claim);

    for (const fact of filteredFacts) {
        const factMemory = await factsManager.addEmbeddingToMemory({
            userId: agentId!,
            agentId,
            content: { text: fact },
            roomId,
            createdAt: Date.now(),
        });

        await factsManager.createMemory(factMemory, true);

        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return filteredFacts;
}

export const factEvaluator: Evaluator = {
    name: "GET_FACTS",
    similes: [
        "GET_CLAIMS",
        "EXTRACT_CLAIMS",
        "EXTRACT_FACTS",
        "EXTRACT_CLAIM",
        "EXTRACT_INFORMATION",
    ],
    validate: async (
        runtime: IAgentRuntime,

        message: Memory
    ): Promise<boolean> => {
        const messageCount = (await runtime.messageManager.countMemories(
            message.roomId
        )) as number;

        const reflectionCount = Math.ceil(runtime.getConversationLength() / 2);

        return messageCount % reflectionCount === 0;
    },
    description:
        "Extract factual information about the people in the conversation, the current events in the world, and anything else that might be important to remember.",
    handler,
    examples: [
        {
            context: `Actors in the scene:
{{user1}}: Programmer and moderator of the local story club.
{{user2}}: New member of the club. Likes to write and read.

Facts about the actors:
None`,
            messages: [
                {
                    user: "{{user1}}",
                    content: { text: "So where are you from" },
                },
                {
                    user: "{{user2}}",
                    content: { text: "I'm from the city" },
                },
                {
                    user: "{{user1}}",
                    content: { text: "Which city?" },
                },
                {
                    user: "{{user2}}",
                    content: { text: "Oakland" },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "Oh, I've never been there, but I know it's in California",
                    },
                },
            ] as ActionExample[],
            outcome: `{ "claim": "{{user2}} is from Oakland", "type": "fact", "in_bio": false, "already_known": false },`,
        },
        {
            context: `Actors in the scene:
{{user1}}: Athelete and cyclist. Worked out every day for a year to prepare for a marathon.
{{user2}}: Likes to go to the beach and shop.

Facts about the actors:
{{user1}} and {{user2}} are talking about the marathon
{{user1}} and {{user2}} have just started dating`,
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "I finally completed the marathon this year!",
                    },
                },
                {
                    user: "{{user2}}",
                    content: { text: "Wow! How long did it take?" },
                },
                {
                    user: "{{user1}}",
                    content: { text: "A little over three hours." },
                },
                {
                    user: "{{user1}}",
                    content: { text: "I'm so proud of myself." },
                },
            ] as ActionExample[],
            outcome: `Claims:
json\`\`\`
[
  { "claim": "Alex just completed a marathon in just under 4 hours.", "type": "fact", "in_bio": false, "already_known": false },
  { "claim": "Alex worked out 2 hours a day at the gym for a year.", "type": "fact", "in_bio": true, "already_known": false },
  { "claim": "Alex is really proud of himself.", "type": "opinion", "in_bio": false, "already_known": false }
]
\`\`\`
`,
        },
        {
            context: `Actors in the scene:
{{user1}}: Likes to play poker and go to the park. Friends with Eva.
{{user2}}: Also likes to play poker. Likes to write and read.

Facts about the actors:
Mike and Eva won a regional poker tournament about six months ago
Mike is married to Alex
Eva studied Philosophy before switching to Computer Science`,
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Remember when we won the regional poker tournament last spring",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "That was one of the best days of my life",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "It really put our poker club on the map",
                    },
                },
            ] as ActionExample[],
            outcome: `Claims:
json\`\`\`
[
  { "claim": "Mike and Eva won the regional poker tournament last spring", "type": "fact", "in_bio": false, "already_known": true },
  { "claim": "Winning the regional poker tournament put the poker club on the map", "type": "opinion", "in_bio": false, "already_known": false }
]
\`\`\``,
        },
    ],
};
```

</details>
Source: https://github.com/elizaOS/eliza/blob/main/packages/plugin-bootstrap/src/evaluators/fact.ts

## Goal Evaluator

The Goal Evaluator tracks progress on conversation objectives by analyzing messages and updating goal status. Goals are structured like this:

```typescript
interface Goal {
    id: string;
    name: string;
    status: "IN_PROGRESS" | "DONE" | "FAILED";
    objectives: Objective[];
}
```

#### Example Goals

Here's how the goal evaluator processes a conversation:

```typescript
// Initial goal state
const goal = {
    id: "book-club-123",
    name: "Complete reading assignment",
    status: "IN_PROGRESS",
    objectives: [
        { description: "Read chapters 1-3", completed: false },
        { description: "Take chapter notes", completed: false },
        { description: "Share thoughts in book club", completed: false }
    ]
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
    id: "book-club-123", 
    name: "Complete reading assignment",
    status: "IN_PROGRESS",                                    // Still in progress
    objectives: [
        { description: "Read chapters 1-3", completed: true }, // Marked complete
        { description: "Take chapter notes", completed: true }, // Marked complete
        { description: "Share thoughts in book club", completed: false } // Still pending
    ]
};

// After the book club meeting, goal would be marked DONE
// If user can't complete objectives, goal could be marked FAILED
```

<details>
<summary>View Full Goal Evaluator Implementation</summary>
```typescript
import { composeContext } from "@elizaos/core";
import { generateText } from "@elizaos/core";
import { getGoals } from "@elizaos/core";
import { parseJsonArrayFromText } from "@elizaos/core";
import {
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type Objective,
    type Goal,
    type State,
    type Evaluator,
} from "@elizaos/core";

const goalsTemplate = `TASK: Update Goal
Analyze the conversation and update the status of the goals based on the new information provided.

# INSTRUCTIONS

- Review the conversation and identify any progress towards the objectives of the current goals.
- Update the objectives if they have been completed or if there is new information about them.
- Update the status of the goal to 'DONE' if all objectives are completed.
- If no progress is made, do not change the status of the goal.

# START OF ACTUAL TASK INFORMATION

{{goals}}
{{recentMessages}}

TASK: Analyze the conversation and update the status of the goals based on the new information provided. Respond with a JSON array of goals to update.
- Each item must include the goal ID, as well as the fields in the goal to update.
- For updating objectives, include the entire objectives array including unchanged fields.
- Only include goals which need to be updated.
- Goal status options are 'IN_PROGRESS', 'DONE' and 'FAILED'. If the goal is active it should always be 'IN_PROGRESS'.
- If the goal has been successfully completed, set status to DONE. If the goal cannot be completed, set status to FAILED.
- If those goal is still in progress, do not include the status field.

Response format should be:
\`\`\`json
[
  {
    "id": <goal uuid>, // required
    "status": "IN_PROGRESS" | "DONE" | "FAILED", // optional
    "objectives": [ // optional
      { "description": "Objective description", "completed": true | false },
      { "description": "Objective description", "completed": true | false }
    ] // NOTE: If updating objectives, include the entire objectives array including unchanged fields.
  }
]
\`\`\``;

async function handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: { [key: string]: unknown } = { onlyInProgress: true }
): Promise<Goal[]> {
    state = (await runtime.composeState(message)) as State;
    const context = composeContext({
        state,
        template: runtime.character.templates?.goalsTemplate || goalsTemplate,
    });

    // Request generateText from OpenAI to analyze conversation and suggest goal updates
    const response = await generateText({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
    });

    // Parse the JSON response to extract goal updates
    const updates = parseJsonArrayFromText(response);

    // get goals
    const goalsData = await getGoals({
        runtime,
        roomId: message.roomId,
        onlyInProgress: options.onlyInProgress as boolean,
    });

    // Apply the updates to the goals
    const updatedGoals = goalsData
        .map((goal: Goal): Goal => {
            const update = updates?.find((u) => u.id === goal.id);
            if (update) {
                // Merge the update into the existing goal
                return {
                    ...goal,
                    ...update,
                    objectives: goal.objectives.map((objective) => {
                        const updatedObjective = update.objectives?.find(uo => uo.description === objective.description);
                        return updatedObjective ? { ...objective, ...updatedObjective } : objective;
                    }),
                };
            }
            return null; // No update for this goal
        })
        .filter(Boolean);

    // Update goals in the database
    for (const goal of updatedGoals) {
        const id = goal.id;
        // delete id from goal
        if (goal.id) delete goal.id;
        await runtime.databaseAdapter.updateGoal({ ...goal, id });
    }

    return updatedGoals; // Return updated goals for further processing or logging
}

export const goalEvaluator: Evaluator = {
    name: "UPDATE_GOAL",
    similes: [
        "UPDATE_GOALS",
        "EDIT_GOAL",
        "UPDATE_GOAL_STATUS",
        "UPDATE_OBJECTIVES",
    ],
    validate: async (
        runtime: IAgentRuntime,
        message: Memory
    ): Promise<boolean> => {
        // Check if there are active goals that could potentially be updated
        const goals = await getGoals({
            runtime,
            count: 1,
            onlyInProgress: true,
            roomId: message.roomId,
        });
        return goals.length > 0;
    },
    description:
        "Analyze the conversation and update the status of the goals based on the new information provided.",
    handler,
    examples: [
        {
            context: `Actors in the scene:
  {{user1}}: An avid reader and member of a book club.
  {{user2}}: The organizer of the book club.

  Goals:
  - Name: Finish reading "War and Peace"
    id: 12345-67890-12345-67890
    Status: IN_PROGRESS
    Objectives:
      - Read up to chapter 20 by the end of the month
      - Discuss the first part in the next meeting`,

            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "I've just finished chapter 20 of 'War and Peace'",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Were you able to grasp the complexities of the characters",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "Yep. I've prepared some notes for our discussion",
                    },
                },
            ],

            outcome: `[
        {
          "id": "12345-67890-12345-67890",
          "status": "DONE",
          "objectives": [
            { "description": "Read up to chapter 20 by the end of the month", "completed": true },
            { "description": "Prepare notes for the next discussion", "completed": true }
          ]
        }
      ]`,
        },

        {
            context: `Actors in the scene:
  {{user1}}: A fitness enthusiast working towards a marathon.
  {{user2}}: A personal trainer.

  Goals:
  - Name: Complete a marathon
    id: 23456-78901-23456-78901
    Status: IN_PROGRESS
    Objectives:
      - Increase running distance to 30 miles a week
      - Complete a half-marathon as practice`,

            messages: [
                {
                    user: "{{user1}}",
                    content: { text: "I managed to run 30 miles this week" },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Impressive progress! How do you feel about the half-marathon next month?",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "I feel confident. The training is paying off.",
                    },
                },
            ],

            outcome: `[
        {
          "id": "23456-78901-23456-78901",
          "objectives": [
            { "description": "Increase running distance to 30 miles a week", "completed": true },
            { "description": "Complete a half-marathon as practice", "completed": false }
          ]
        }
      ]`,
        },

        {
            context: `Actors in the scene:
  {{user1}}: A student working on a final year project.
  {{user2}}: The project supervisor.

  Goals:
  - Name: Finish the final year project
    id: 34567-89012-34567-89012
    Status: IN_PROGRESS
    Objectives:
      - Submit the first draft of the thesis
      - Complete the project prototype`,

            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "I've submitted the first draft of my thesis.",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "Well done. How is the prototype coming along?",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "It's almost done. I just need to finalize the testing phase.",
                    },
                },
            ],

            outcome: `[
        {
          "id": "34567-89012-34567-89012",
          "objectives": [
            { "description": "Submit the first draft of the thesis", "completed": true },
            { "description": "Complete the project prototype", "completed": false }
          ]
        }
      ]`,
        },

        {
            context: `Actors in the scene:
        {{user1}}: A project manager working on a software development project.
        {{user2}}: A software developer in the project team.

        Goals:
        - Name: Launch the new software version
          id: 45678-90123-45678-90123
          Status: IN_PROGRESS
          Objectives:
            - Complete the coding for the new features
            - Perform comprehensive testing of the software`,

            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "How's the progress on the new features?",
                    },
                },
                {
                    user: "{{user2}}",
                    content: {
                        text: "We've encountered some unexpected challenges and are currently troubleshooting.",
                    },
                },
                {
                    user: "{{user1}}",
                    content: {
                        text: "Let's move on and cancel the task.",
                    },
                },
            ],

            outcome: `[
        {
          "id": "45678-90123-45678-90123",
          "status": "FAILED"
      ]`,
        },
    ],
};
```
</details>

Source: https://github.com/elizaOS/eliza/blob/main/packages/plugin-bootstrap/src/evaluators/goals.ts

---

## FAQ

### How do evaluators differ from providers?
While [providers](/api/interfaces/Provider) supply data to the agent before responses, evaluators analyze conversations after responses. Providers inform decisions, evaluators learn from outcomes.

### Can evaluators modify agent behavior?
Evaluators can influence future behavior by storing insights in memory, but cannot directly modify agent responses or interrupt ongoing actions.

### How many evaluators can run simultaneously?
There's no hard limit, but each evaluator adds processing overhead. Focus on essential evaluations and use efficient validation to optimize performance.

### Can evaluators communicate with each other?
Evaluators don't directly communicate but can share data through the memory system. One evaluator can read insights stored by another.

### How are evaluation results persisted?
Results are stored using the runtime's memory managers with embeddings for efficient retrieval. See the [`IMemoryManager`](/api/interfaces/IMemoryManager) interface for details.

### What's the difference between similes and examples in evaluators?
Similes provide alternative descriptions of the evaluator's purpose, while examples show concrete scenarios with inputs and expected outcomes. Examples help verify correct implementation.

### Can evaluators be conditionally enabled?
Yes, use the validation function to control when evaluators run. This can be based on message content, user status, or other runtime conditions.
