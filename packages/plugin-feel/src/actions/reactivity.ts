import { IAgentRuntime, Memory, State, HandlerCallback } from "@ai16z/eliza";
import { MemoryManager } from "@ai16z/eliza";

// Emotional decay rates (how quickly emotions return to baseline)
const emotionalDecay = {
    joy: 0.1,        // Quickly returns to reserved state
    sadness: 0.05,   // Holds onto sadness longer
    anger: 0.15,     // Relatively quick to regain composure
    fear: 0.08,      // Takes time to feel secure again
    romantic: 0.2,   // Very quick to suppress romantic feelings
    embarrassment: 0.12  // Moderately quick to regain composure
};

// Baseline emotional states
const emotionalBaseline = {
    joy: 0.2,
    sadness: 0.3,
    anger: 0.1,
    fear: 0.2,
    romantic: 0.1,
    embarrassment: 0.1
};

// Emotional profile (max values for each emotion)
const emotionalProfile = {
    joy: { max: 0.8 },
    sadness: { max: 0.9 },
    anger: { max: 0.7 },
    fear: { max: 0.8 },
    romantic: { max: 0.6 },
    embarrassment: { max: 0.7 }
};

export const adjustEmotionAction = {
    name: "ADJUST_EMOTION",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback
    ) => {
        // Get current emotional state
        const emotionManager = new MemoryManager({
            runtime,
            tableName: "emotions"
        });

        const currentEmotions = await emotionManager.getMemories({
            agentId: runtime.agentId,
            targetId: message.userId,
            count: 1
        });

        const currentState = currentEmotions[0]?.content || { ...emotionalBaseline };
        const lastUpdate = currentEmotions[0]?.content?.timestamp || Date.now();
        
        // Calculate time-based decay
        const timeDelta = (Date.now() - lastUpdate) / (1000 * 60); // Minutes
        const decayedState = Object.entries(currentState).reduce((acc, [emotion, value]) => {
            if (emotion === 'timestamp' || emotion === 'profile') return acc;
            
            const baseline = emotionalBaseline[emotion];
            const decayRate = emotionalDecay[emotion];
            
            // Move value towards baseline based on time passed
            const decayAmount = decayRate * timeDelta;
            const newValue = value > baseline 
                ? Math.max(baseline, value - decayAmount)
                : Math.min(baseline, value + decayAmount);
            
            acc[emotion] = newValue;
            return acc;
        }, {});
        
        // Get emotional triggers from the evaluator
        const triggers = state.emotionalTriggers || [];
        
        // Apply each trigger to update emotional state
        const newState = { ...decayedState };
        
        triggers.forEach(trigger => {
            const { emotion, intensity } = trigger;
            if (!emotionalBaseline.hasOwnProperty(emotion)) return;

            // Get max value for this emotion
            const maxValue = emotionalProfile[emotion]?.max || 1.0;
            
            // Update emotion value, ensuring it stays between 0 and max
            newState[emotion] = Math.max(0, Math.min(maxValue, 
                (newState[emotion] || emotionalBaseline[emotion]) + intensity
            ));
        });

        // Store the updated emotional state
        await emotionManager.createMemory({
            agentId: runtime.agentId,
            targetId: message.userId,
            content: {
                ...newState,
                timestamp: Date.now(),
                profile: runtime.agentId
            }
        });

        // Notify about significant emotional changes
        const significantChanges = Object.entries(newState).filter(([emotion, value]) => {
            const previousValue = currentState[emotion] || emotionalBaseline[emotion];
            const threshold = emotion === 'anger' ? 0.4 : 0.3; // Higher threshold for showing anger
            return Math.abs(value - previousValue) >= threshold;
        });

        if (significantChanges.length > 0 && callback) {
            const changeDescription = significantChanges
                .map(([emotion, value]) => {
                    const intensity = value > 0.7 ? "significantly" : 
                                    value > 0.5 ? "noticeably" : 
                                    "slightly";
                    return `${emotion} level has ${intensity} changed`;
                })
                .join(", ");
            
            await callback({
                text: `Emotional state update: ${changeDescription}`,
                action: "EMOTION_UPDATE"
            });
        }

        return true;
    },
    description: "Adjusts the agent's emotional state based on triggers, with appropriate emotional restraint and decay"
};
