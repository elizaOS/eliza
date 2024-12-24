import { embed } from "@ai16z/eliza/src/embedding.ts";
import { MemoryManager } from "@ai16z/eliza";
import { formatMessages } from "@ai16z/eliza/src/messages.ts";
import { IAgentRuntime, Memory, Provider, State } from "@ai16z/eliza";

interface EmotionalState {
    userId: string;
    emotions: {
        [key: string]: number;  // maps emotion name to current value
    };
    lastInteraction: string;    // timestamp
    overallSentiment: string;   // e.g., "cold", "neutral", "warming"
}

// How much emotions decay per hour of inactivity
const EMOTION_DECAY_RATES = {
    trust: -0.1,    // Trust decays moderately fast
    warmth: -0.15,  // Warmth decays faster (back to cold default)
    disdain: 0.05,  // Disdain slowly increases
    calm: 0.1       // Calm slowly recovers
};

// Calculate emotional decay based on time passed
function calculateEmotionalDecay(lastInteraction: string): { [key: string]: number } {
    const hoursPassed = (Date.now() - new Date(lastInteraction).getTime()) / (1000 * 60 * 60);
    const decay: { [key: string]: number } = {};
    
    Object.entries(EMOTION_DECAY_RATES).forEach(([emotion, ratePerHour]) => {
        decay[emotion] = ratePerHour * hoursPassed;
    });
    
    return decay;
}

// Determine overall sentiment based on emotional state
function determineOverallSentiment(emotions: { [key: string]: number }): string {
    const { trust, warmth, disdain } = emotions;
    
    if (trust < 0.2 && warmth < 0.2 && disdain > 0.6) return "hostile";
    if (trust < 0.3 && warmth < 0.2) return "cold";
    if (trust > 0.3 && warmth > 0.2) return "warming";
    if (trust > 0.4 && warmth > 0.3) return "friendly";
    
    return "neutral";
}

const sentimentProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const userId = message.userId;
        
        const memoryManager = new MemoryManager({
            runtime,
            tableName: "emotional_states",
        });

        // Get recent sentiment evaluations for this user
        const recentEvaluations = await memoryManager.getMemories({
            userId,
            roomId: message.roomId,
            count: 10,  // Get last 10 evaluations
            agentId: runtime.agentId,
            type: "sentiment_evaluation"
        });

        // Initialize with default emotional state
        let currentState: EmotionalState = {
            userId,
            emotions: {
                calm: runtime.character.emotionalArchetype.calm.maxValue,
                disdain: runtime.character.emotionalArchetype.disdain.maxValue * 0.5,
                trust: 0,
                warmth: 0
            },
            lastInteraction: new Date().toISOString(),
            overallSentiment: "cold"
        };

        if (recentEvaluations.length > 0) {
            // Get the most recent state
            const lastEvaluation = recentEvaluations[0];
            const lastState = lastEvaluation.content.evaluation;
            
            // Apply emotional decay based on time since last interaction
            const decay = calculateEmotionalDecay(lastEvaluation.createdAt.toString());
            
            // Update emotions based on decay and character's emotional limits
            Object.entries(currentState.emotions).forEach(([emotion, value]) => {
                const maxValue = runtime.character.emotionalArchetype[emotion]?.maxValue || 1.0;
                const decayValue = decay[emotion] || 0;
                
                // Apply decay and ensure within bounds [0, maxValue]
                currentState.emotions[emotion] = Math.max(0, Math.min(maxValue, value + decayValue));
            });

            // Update last interaction time
            currentState.lastInteraction = new Date().toISOString();
        }

        // Update overall sentiment
        currentState.overallSentiment = determineOverallSentiment(currentState.emotions);

        // Format response for agent's context
        return `Ming's emotional state towards ${message.userId}:
Current Feelings:
- Disdain: ${currentState.emotions.disdain.toFixed(2)} ${currentState.emotions.disdain > 0.6 ? "(Very High)" : currentState.emotions.disdain > 0.4 ? "(High)" : "(Moderate)"}
- Trust: ${currentState.emotions.trust.toFixed(2)} ${currentState.emotions.trust > 0.4 ? "(Warming Up)" : "(Guarded)"}
- Warmth: ${currentState.emotions.warmth.toFixed(2)} ${currentState.emotions.warmth > 0.3 ? "(Showing Warmth)" : "(Cold)"}
- Calm: ${currentState.emotions.calm.toFixed(2)} ${currentState.emotions.calm > 0.7 ? "(Very Composed)" : "(Slightly Agitated)"}

Overall Disposition: ${currentState.overallSentiment.toUpperCase()}
Last Interaction: ${new Date(currentState.lastInteraction).toLocaleString()}

Instructions:
${currentState.overallSentiment === "hostile" ? "- Be overtly cold and dismissive" :
  currentState.overallSentiment === "cold" ? "- Maintain emotional distance and show mild disdain" :
  currentState.overallSentiment === "warming" ? "- Show subtle signs of accepting their presence" :
  currentState.overallSentiment === "friendly" ? "- Display reserved but genuine warmth" :
  "- Remain neutral but distant"}`;
    },
};

export { sentimentProvider };
