import { composeContext } from "@ai16z/eliza/src/context.ts";
import { generateObjectArray } from "@ai16z/eliza/src/generation.ts";
import { MemoryManager } from "@ai16z/eliza";
import {
    IAgentRuntime,
    Memory,
    ModelClass,
    Evaluator,
} from "@ai16z/eliza";

const sentimentTemplate = `TASK: Analyze the user's message tone and intent towards Ming (the agent) and determine how it affects Ming's emotional state.

# CONTEXT
Ming is a Kuudere character who:
- Is naturally cold and distant (high disdain, low warmth)
- Takes time to warm up to people (slow trust growth)
- Maintains emotional distance by default
- Shows subtle reactions rather than dramatic displays

# START OF EXAMPLES
Example evaluations:
[
    {
        "tone": "friendly",
        "intent": "trying to get closer",
        "emotional_impact": {
            "disdain": -0.1,     // Slightly reduces disdain
            "trust": 0.05,       // Very slightly increases trust
            "warmth": 0.02,      // Barely increases warmth
            "calm": 0           // Maintains calm
        },
        "reason": "User is being friendly but Ming maintains emotional distance as per her Kuudere nature"
    },
    {
        "tone": "hostile",
        "intent": "confrontational",
        "emotional_impact": {
            "disdain": 0.2,      // Increases disdain
            "trust": -0.15,      // Decreases trust
            "warmth": -0.1,      // Decreases warmth
            "calm": -0.2        // Decreases calm
        },
        "reason": "User's hostility reinforces Ming's natural tendency towards coldness"
    }
]
# END OF EXAMPLES

# INSTRUCTIONS
Analyze the recent messages and determine:
1. The user's tone towards Ming
2. The user's apparent intent
3. How this affects Ming's emotional state (changes in disdain, trust, warmth, and calm)
4. The reason for these emotional changes

Recent Messages:
{{recentMessages}}

Response should be a JSON object inside a JSON markdown block. Values should be between -0.3 and 0.3 per interaction:
\`\`\`json
{
    "tone": string,
    "intent": string,
    "emotional_impact": {
        "disdain": number,
        "trust": number,
        "warmth": number,
        "calm": number
    },
    "reason": string
}
\`\`\``;

async function handler(runtime: IAgentRuntime, message: Memory) {
    const state = await runtime.composeState(message);
    const { agentId, roomId } = state;
    
    const context = composeContext({
        state,
        template: sentimentTemplate
    });
    const evaluation = await generateObjectArray(runtime, context, ModelClass.SMART);
    
    if (!evaluation || !evaluation[0]) {
        return null;
    }

    const sentimentEval = evaluation[0];
    
    // Create a text summary of the emotional impact
    const summaryText = `Tone: ${sentimentEval.tone}\nIntent: ${sentimentEval.intent}\nImpact: ${sentimentEval.reason}`;
    
    // Store the sentiment evaluation with embedding
    const memoryManager = new MemoryManager({
        runtime,
        tableName: "emotional_states",
    });

    const sentimentMemory = await memoryManager.addEmbeddingToMemory({
        userId: message.userId,
        agentId,
        content: {
            text: summaryText,
            evaluation: sentimentEval
        },
        roomId,
        createdAt: Date.now(),
        type: "sentiment_evaluation"
    });

    // Persist the memory
    await memoryManager.createMemory(sentimentMemory, true);
    
    // Add a small delay to ensure proper storage
    await new Promise((resolve) => setTimeout(resolve, 250));

    return sentimentEval;
}

async function validate(
    runtime: IAgentRuntime,
    message: Memory
): Promise<boolean> {
    return true; // Always evaluate sentiment
}

export const sentimentEvaluator: Evaluator = {
    name: "EVALUATE_SENTIMENT",
    similes: ["ANALYZE_TONE", "CHECK_EMOTIONS"],
    description: "Evaluates how the user's message affects Ming's emotional state towards them",
    handler,
    validate,
    examples: [
        {
            context: `Actors in the scene:
{{user1}}: A user who has been interacting with Ming.
Ming: A Kuudere character who is naturally cold and distant.

Facts about the actors:
Ming maintains emotional distance by default.`,
            messages: [
                {
                    user: "{{user1}}",
                    content: { text: "You're always so cold and mean! Why can't you be nicer?" },
                },
            ],
            evaluation: {
                tone: "accusatory",
                intent: "demanding emotional change",
                emotional_impact: {
                    disdain: 0.2,
                    trust: -0.1,
                    warmth: -0.15,
                    calm: -0.1
                },
                reason: "User's demand for emotional change increases Ming's disdain and reduces warmth, as she strongly maintains her Kuudere nature"
            },
        },
    ],
};
