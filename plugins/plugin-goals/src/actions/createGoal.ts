import {
  type Action,
  type ActionExample,
  formatMessages,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
  composePrompt,
} from '@elizaos/core';
import { createGoalDataService } from '../services/goalDataService';

// Interface for parsed goal data
interface GoalInput {
  name: string;
  description?: string;
  ownerType: 'agent' | 'entity';
}

// Interface for similarity check result
interface SimilarityCheckResult {
  hasSimilar: boolean;
  similarGoalName?: string;
  confidence: number;
}

/**
 * Template for extracting goal information from the user's message.
 */
const extractGoalTemplate = `
# Task: Extract Goal Information

## User Message
{{text}}

## Message History
{{messageHistory}}

## Instructions
Parse the user's message to extract information for creating a new goal.
Determine if this goal is for the agent itself or for tracking a user's goal.

Goals should be long-term achievable objectives, not short-term tasks.

Return an XML object with these fields:
<response>
  <name>A clear, concise name for the goal</name>
  <description>Optional detailed description</description>
  <ownerType>Either "agent" (for agent's own goals) or "entity" (for user's goals)</ownerType>
</response>

If the message doesn't clearly indicate a goal to create, return empty response.

## Example Output Format
<response>
  <name>Learn Spanish fluently</name>
  <description>Achieve conversational fluency in Spanish within 6 months</description>
  <ownerType>entity</ownerType>
</response>
`;

/**
 * Template for checking if a similar goal already exists
 */
const checkSimilarityTemplate = `
# Task: Check Goal Similarity

## New Goal
Name: {{newGoalName}}
Description: {{newGoalDescription}}

## Existing Goals
{{existingGoals}}

## Instructions
Determine if the new goal is similar to any existing goals.
Consider goals similar if they have the same objective, even if worded differently.

Return an XML object:
<response>
  <hasSimilar>true or false</hasSimilar>
  <similarGoalName>Name of the similar goal if found</similarGoalName>
  <confidence>0-100 indicating confidence in similarity</confidence>
</response>

## Example
New Goal: "Get better at public speaking"
Existing Goal: "Improve presentation skills"
These are similar (confidence: 85)
`;

/**
 * Extracts goal information from the user's message.
 */
async function extractGoalInfo(
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<GoalInput | null> {
  try {
    const messageHistory = formatMessages({
      messages: state.data.messages || [],
      entities: state.data.entities || [],
    });

    const prompt = composePrompt({
      state: {
        text: message.content.text || '',
        messageHistory,
      },
      template: extractGoalTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    });

    logger.debug('Extract goal result:', result);

    // Parse XML from the text results
    const parsedResult = parseKeyValueXml(result);

    if (!parsedResult || !parsedResult.name) {
      logger.error('Failed to extract valid goal information from XML');
      return null;
    }

    return {
      name: String(parsedResult.name),
      description: parsedResult.description ? String(parsedResult.description) : undefined,
      ownerType: (parsedResult.ownerType === 'agent' ? 'agent' : 'entity') as 'agent' | 'entity',
    };
  } catch (error) {
    logger.error('Error extracting goal information:', error);
    return null;
  }
}

/**
 * Checks if a similar goal already exists
 */
async function checkForSimilarGoal(
  runtime: IAgentRuntime,
  newGoal: GoalInput,
  existingGoals: any[]
): Promise<SimilarityCheckResult> {
  try {
    if (existingGoals.length === 0) {
      return { hasSimilar: false, confidence: 0 };
    }

    // Format existing goals
    const existingGoalsText = existingGoals
      .map((goal) => `- ${goal.name}: ${goal.description || 'No description'}`)
      .join('\n');

    const prompt = composePrompt({
      state: {
        newGoalName: newGoal.name,
        newGoalDescription: newGoal.description || 'No description',
        existingGoals: existingGoalsText,
      },
      template: checkSimilarityTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResult = parseKeyValueXml(result) as SimilarityCheckResult | null;

    if (!parsedResult) {
      return { hasSimilar: false, confidence: 0 };
    }

    return {
      hasSimilar: String(parsedResult.hasSimilar) === 'true',
      similarGoalName: parsedResult.similarGoalName,
      confidence: parseInt(String(parsedResult.confidence || 0), 10),
    };
  } catch (error) {
    logger.error('Error checking for similar goals:', error);
    return { hasSimilar: false, confidence: 0 };
  }
}

/**
 * The CREATE_GOAL action allows the agent to create a new goal.
 */
export const createGoalAction: Action = {
  name: 'CREATE_GOAL',
  similes: ['ADD_GOAL', 'NEW_GOAL', 'SET_GOAL', 'TRACK_GOAL'],
  description: 'Creates a new long-term achievable goal for the agent or a user.',

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Always allow validation, we'll check limits in the handler
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    try {
      // Step 1: Compose state if needed
      const currentState = state || (await runtime.composeState(message, ['GOALS']));

      // Step 2: Extract goal info from the message
      const goalInfo = await extractGoalInfo(runtime, message, currentState);

      if (!goalInfo) {
        if (callback) {
          await callback({
            text: "I couldn't understand what goal you want to create. Could you please provide a clear goal description?",
            actions: ['CREATE_GOAL_FAILED'],
            source: message.content.source,
          });
        }
        return;
      }

      // Step 3: Get the data service
      const dataService = createGoalDataService(runtime);

      // Determine the owner
      const ownerId = goalInfo.ownerType === 'agent' ? runtime.agentId : (message.entityId as UUID);

      // Step 4: Check goal count
      const activeGoalCount = await dataService.countGoals(goalInfo.ownerType, ownerId, false);

      if (activeGoalCount >= 10) {
        if (callback) {
          await callback({
            text: `Cannot add new goal: The ${goalInfo.ownerType === 'agent' ? 'agent' : 'user'} already has 10 active goals, which is the maximum allowed. Please complete or remove some existing goals first.`,
            actions: ['CREATE_GOAL_LIMIT_REACHED'],
            source: message.content.source,
          });
        }
        return;
      }

      // Step 5: Check for similar goals
      const existingGoals = await dataService.getAllGoalsForOwner(goalInfo.ownerType, ownerId);
      const similarityCheck = await checkForSimilarGoal(runtime, goalInfo, existingGoals);

      if (similarityCheck.hasSimilar && similarityCheck.confidence > 70) {
        if (callback) {
          await callback({
            text: `It looks like there's already a similar goal: "${similarityCheck.similarGoalName}". Are you sure you want to add this as a separate goal?`,
            actions: ['CREATE_GOAL_SIMILAR_EXISTS'],
            source: message.content.source,
          });
        }
        return;
      }

      // Step 6: Create the goal
      const tags = ['GOAL'];
      if (goalInfo.ownerType === 'agent') {
        tags.push('agent-goal');
      } else {
        tags.push('entity-goal');
      }

      const metadata: Record<string, any> = {
        createdAt: new Date().toISOString(),
      };

      const createdGoalId = await dataService.createGoal({
        agentId: runtime.agentId,
        ownerType: goalInfo.ownerType,
        ownerId,
        name: goalInfo.name,
        description: goalInfo.description || goalInfo.name,
        metadata,
        tags,
      });

      if (!createdGoalId) {
        throw new Error('Failed to create goal');
      }

      // Step 7: Send success message with guidance based on goal count
      let successMessage = `✅ New goal created: "${goalInfo.name}"`;

      if (activeGoalCount >= 4) {
        successMessage += `\n\n⚠️ You now have ${activeGoalCount + 1} active goals. Consider focusing on completing some of these before adding more.`;
      }

      if (callback) {
        await callback({
          text: successMessage,
          actions: ['CREATE_GOAL_SUCCESS'],
          source: message.content.source,
        });
      }
    } catch (error) {
      logger.error('Error in createGoal handler:', error);
      if (callback) {
        await callback({
          text: 'I encountered an error while creating your goal. Please try again.',
          actions: ['CREATE_GOAL_FAILED'],
          source: message.content.source,
        });
      }
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I want to set a goal to learn French fluently',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ New goal created: "Learn French fluently"',
          actions: ['CREATE_GOAL_SUCCESS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Add a goal for me to run a marathon',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ New goal created: "Run a marathon"',
          actions: ['CREATE_GOAL_SUCCESS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I have a goal to get better at cooking',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ New goal created: "Get better at cooking"\n\n⚠️ You now have 5 active goals. Consider focusing on completing some of these before adding more.',
          actions: ['CREATE_GOAL_SUCCESS'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default createGoalAction;
