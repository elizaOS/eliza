import { 
    composeContext,
    generateMessageResponse,
    type Action,
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    ModelClass,
    elizaLogger
} from "@elizaos/core";

const USER_PREFS_TABLE = "user_preferences";

const recommendMealTemplate = `# Task: Recommend a meal for the user based on their fitness goals and preferences

About the user:
{{userPreferences}}

Recent Messages:
{{recentMessages}}

# Instructions: Generate a meal recommendation that:
- Aligns with their fitness goals
- Respects dietary restrictions
- Considers their allergies
- Is available at nearby restaurants or can be prepared at home
- Includes nutritional information and benefits

The response should be clear, informative, and engaging.`;

export const recommendMealAction: Action = {
    name: "RECOMMEND_MEAL",
    similes: ["SUGGEST_FOOD", "MEAL_PLAN", "FOOD_RECOMMENDATION"],
    
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.debug("[RECOMMEND_MEAL] Validating action for message:", message.content);
        try {
            // Get user preferences from memories with more detailed logging
            elizaLogger.debug("[RECOMMEND_MEAL] Attempting to fetch preferences");
            const userPrefs = await runtime.databaseAdapter.getMemories({
                roomId: message.roomId,
                tableName: USER_PREFS_TABLE,
                agentId: runtime.agentId,
                count: 1
            });
            
            elizaLogger.debug("[RECOMMEND_MEAL] Raw user preferences result:", userPrefs);
    
            // Modified check: look for preferences in the content structure
            const hasPreferences = userPrefs && 
                                 userPrefs.length > 0 && 
                                 userPrefs[0].content &&
                                 (userPrefs[0].content.preferences || 
                                  userPrefs[0].content.text);
    
            elizaLogger.debug("[RECOMMEND_MEAL] Has preferences:", hasPreferences);
            
            return true;  // Always return true to allow the handler to manage the flow
        } catch (error) {
            elizaLogger.error("[RECOMMEND_MEAL] Validation error:", error);
            return true;  // Still return true to allow handler to manage
        }
    },
    description: "Recommend meals based on user's fitness goals, dietary preferences, and restrictions. Use when user asks for food suggestions or meal planning advice.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        options: any,
        callback?: HandlerCallback
    ): Promise<Content | null> => {
        elizaLogger.debug("[RECOMMEND_MEAL] Handler started");
        if (!callback) {
            elizaLogger.error("[RECOMMEND_MEAL] No callback provided");
            return null;
        }

        try {
            // Initialize state if undefined
            if (!state) {
                elizaLogger.debug("[RECOMMEND_MEAL] Initializing state");
                state = await runtime.composeState(message);
            }

            // Add a small delay to ensure preferences are stored
        await new Promise(resolve => setTimeout(resolve, 1000))

            // Get user preferences from memories
            elizaLogger.debug("[RECOMMEND_MEAL] Fetching user preferences");
            const userPrefs = await runtime.databaseAdapter.getMemories({
                roomId: message.roomId,
                tableName: USER_PREFS_TABLE,
                agentId: runtime.agentId,
                count: 1
            });
            
            elizaLogger.debug("[RECOMMEND_MEAL] User preferences found:", userPrefs);
            
            // Modified preference check and handling
            if (!userPrefs || userPrefs.length === 0) {
                return null;  // Return null instead of sending the preferences message
            }
            
            // Extract preferences from the stored content
            const preferences = userPrefs[0].content.preferences || 
                               JSON.parse(userPrefs[0].content.text || '{}');
            
            // Update state with user preferences
            state = {
                ...state,
                userPreferences: preferences
            };
            elizaLogger.debug("[RECOMMEND_MEAL] Updated state:", state);

            // Generate recommendation using the template
            elizaLogger.debug("[RECOMMEND_MEAL] Composing context");
            const context = composeContext({
                state,
                template: recommendMealTemplate
            });
            elizaLogger.debug("[RECOMMEND_MEAL] Context composed:", context);

            elizaLogger.debug("[RECOMMEND_MEAL] Generating response");
            const response = await generateMessageResponse({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });
            elizaLogger.debug("[RECOMMEND_MEAL] Response generated:", response);

            // Log the recommendation
            elizaLogger.debug("[RECOMMEND_MEAL] Logging to database");
            await runtime.databaseAdapter.log({
                body: { message, context, response },
                userId: message.userId,
                roomId: message.roomId,
                type: "meal_recommendation"
            });

            // Create the response content
            const responseContent: Content = {
                text: response.text,
                action: "RECOMMEND_MEAL",
                inReplyTo: message.id
            };
            
            elizaLogger.debug("[RECOMMEND_MEAL] Sending response");
            await callback(responseContent);
            return responseContent;

        } catch (error) {
            elizaLogger.error("[RECOMMEND_MEAL] Error:", error);
            return null;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I need help finding something healthy to eat for lunch"
                }
            },
            {
                user: "NutriFi",
                content: {
                    text: "Based on your goal to build muscle and preference for high-protein meals, I recommend a grilled chicken quinoa bowl. It packs 35g of protein, complex carbs from quinoa, and healthy fats from avocado. You can get this at Fresh Bowl on 5th Street or I can share a recipe to make it at home.",
                    action: "RECOMMEND_MEAL"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I'm vegan and trying to lose weight. What should I eat for dinner?"
                }
            },
            {
                user: "NutriFi",
                content: {
                    text: "For your weight loss goals while maintaining a vegan diet, I suggest a Buddha bowl with roasted chickpeas, quinoa, mixed vegetables, and tahini dressing. This meal is around 450 calories with 20g of plant-based protein. The high fiber content will help you feel full longer. Whole Foods has a great pre-made version, or would you like the recipe?",
                    action: "RECOMMEND_MEAL"
                }
            }
        ]
    ] as ActionExample[][]
};