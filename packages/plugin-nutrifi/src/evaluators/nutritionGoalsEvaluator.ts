import { composeContext } from "@elizaos/core";
import { generateText } from "@elizaos/core";
import { parseJsonArrayFromText } from "@elizaos/core";
import {
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Evaluator,
} from "@elizaos/core";

const nutritionTemplate = `TASK: Update Nutrition Goals and Preferences
Analyze the conversation and update the user's nutritional preferences and goals based on the new information provided.

# INSTRUCTIONS
- Review the conversation for any mentions of:
  - Dietary preferences (vegan, vegetarian, etc.)
  - Fitness goals (weight loss, muscle gain, etc.)
  - Allergies or restrictions
  - Meal timing preferences
  - Caloric or macro targets
- Update only the relevant fields based on new information
- If no relevant nutrition information is mentioned, do not make updates

# START OF ACTUAL TASK INFORMATION

{{userPreferences}}
{{recentMessages}}

TASK: Analyze the conversation and update the nutritional preferences. Respond with a JSON object of preferences to update.
- Include only fields that need updating
- For allergies and restrictions, include the complete array even if only adding one item
- Caloric targets should be realistic daily values
- If mentioned, include specific macro targets (protein, carbs, fats)

Response format should be:
\`\`\`json
{
  "userId": "<user id>",
  "dietaryPreferences": {
    "type": "vegan" | "vegetarian" | "omnivore" | "pescatarian" | "keto" | "paleo",
    "restrictions": ["dairy-free", "gluten-free", etc],
    "allergies": ["nuts", "shellfish", etc]
  },
  "fitnessGoals": {
    "primary": "weight_loss" | "muscle_gain" | "maintenance" | "performance",
    "calorieTarget": number,
    "macroTargets": {
      "protein": number,
      "carbs": number,
      "fats": number
    }
  },
  "mealPreferences": {
    "preferredMealTimes": ["breakfast", "lunch", "dinner", "snacks"],
    "mealSize": "small" | "medium" | "large"
  }
}
\`\`\``;

async function handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined
): Promise<boolean> {
    console.log("[UPDATE_NUTRITION] Handler started");
    try {
        state = (await runtime.composeState(message)) as State;
        const context = composeContext({
            state,
            template: nutritionTemplate,
        });

        // Generate analysis of nutrition preferences
        const response = await generateText({
            runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        // Add debug logging
        console.log("[UPDATE_NUTRITION] Generated response:", response);

        // Parse the JSON response - Modified to handle string better
        let updates;
        try {
            // Look for JSON structure in the response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                updates = JSON.parse(jsonMatch[0]);
            }
        } catch (parseError) {
            console.error("[UPDATE_NUTRITION] JSON parse error:", parseError);
        }

        if (updates) {
            // Store preferences with proper structure
            await runtime.databaseAdapter.createMemory({
                id: message.id,
                userId: message.userId,
                agentId: runtime.agentId,
                roomId: message.roomId,
                content: {
                    text: JSON.stringify(updates),
                    preferences: updates  // Add structured data
                }
            }, 'user_preferences');

            console.log("[UPDATE_NUTRITION] Attempting to verify storage...");
            const storedPrefs = await runtime.databaseAdapter.getMemories({
                roomId: message.roomId,
                tableName: 'user_preferences',
                agentId: runtime.agentId,
                count: 1
            });
            console.log("[UPDATE_NUTRITION] Stored preferences found:", storedPrefs);
            return true;
        }

        return false;
    } catch (error) {
        console.error("[UPDATE_NUTRITION] Error:", error);
        return false;
    }
}

export const nutritionGoalsEvaluator: Evaluator = {
    name: "UPDATE_NUTRITION",
    similes: [
        "UPDATE_DIET",
        "EDIT_NUTRITION_GOALS",
        "UPDATE_MEAL_PREFERENCES",
        "UPDATE_FITNESS_GOALS"
    ],
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        console.log("[UPDATE_NUTRITION] Validating message:", message.content.text);
        
        // Check if message contains nutrition-related content
        const content = message.content.text.toLowerCase();
        const nutritionKeywords = [
            'diet', 'food', 'eat', 'meal', 'calories',
            'protein', 'carbs', 'weight', 'allergic',
            'vegan', 'vegetarian', 'gluten', 'dairy',
            'fitness', 'goals', 'endurance', 'marathon',
            'activity', 'restriction'  // Added more relevant keywords
        ];
        
        const foundKeywords = nutritionKeywords.filter(keyword => content.includes(keyword));
        console.log("[UPDATE_NUTRITION] Found keywords:", foundKeywords);
        
        const shouldProcess = foundKeywords.length > 0;
        console.log("[UPDATE_NUTRITION] Should process:", shouldProcess);
        
        return shouldProcess;
    },
    description: "Analyze conversation for nutrition-related preferences and goals and update user profile accordingly.",
    handler,
    examples: [
        {
            context: `User discussing dietary preferences and restrictions.
            Current preferences: None set`,
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "I'm trying to lose weight and I'm vegetarian. Also allergic to nuts."
                    }
                }
            ],
            outcome: `{
                "userId": "{{user1}}",
                "dietaryPreferences": {
                    "type": "vegetarian",
                    "restrictions": [],
                    "allergies": ["nuts"]
                },
                "fitnessGoals": {
                    "primary": "weight_loss"
                }
            }`
        },
        // Add more examples...
    ]
};