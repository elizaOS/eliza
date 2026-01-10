import {
  type Action,
  type ActionExample,
  composePrompt,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
} from '@elizaos/core';
import { createGoalDataService, type GoalData } from '../services/goalDataService';

// Interface for goal selection properties
interface GoalSelection {
  goalId: string;
  goalName: string;
  isFound: boolean;
}

// Interface for goal update properties
interface GoalUpdate {
  name?: string;
  description?: string;
}

/**
 * Template for extracting which goal to update from the user's message
 */
const extractGoalTemplate = `
# Task: Extract Goal Selection Information

## User Message
{{text}}

## Available Goals
{{availableGoals}}

## Instructions
Parse the user's message to identify which goal they want to update or modify.
Match against the list of available goals by name or description.
If multiple goals have similar names, choose the closest match.

Return an XML object with:
<response>
  <goalId>ID of the goal being updated, or 'null' if not found</goalId>
  <goalName>Name of the goal being updated, or 'null' if not found</goalName>
  <isFound>'true' or 'false' indicating if a matching goal was found</isFound>
</response>

## Example Output Format
<response>
  <goalId>123e4567-e89b-12d3-a456-426614174000</goalId>
  <goalName>Learn French fluently</goalName>
  <isFound>true</isFound>
</response>

If no matching goal was found:
<response>
  <goalId>null</goalId>
  <goalName>null</goalName>
  <isFound>false</isFound>
</response>
`;

/**
 * Template for extracting goal update information
 */
const extractUpdateTemplate = `
# Task: Extract Goal Update Information

## User Message
{{text}}

## Current Goal Details
{{goalDetails}}

## Instructions
Parse the user's message to determine what changes they want to make to the goal.
Only name and description can be updated.

Return an XML object with these potential fields (only include fields that should be changed):
<response>
  <name>New name for the goal</name>
  <description>New description for the goal</description>
</response>

## Example Output Format
<response>
  <name>Learn Spanish fluently</name>
  <description>Achieve conversational fluency in Spanish within 12 months</description>
</response>
`;

/**
 * Extracts which goal the user wants to update
 */
async function extractGoalSelection(
  runtime: IAgentRuntime,
  message: Memory,
  availableGoals: GoalData[]
): Promise<GoalSelection> {
  try {
    // Format available goals for the prompt
    const goalsText = availableGoals
      .map((goal) => {
        return `ID: ${goal.id}\nName: ${goal.name}\nDescription: ${goal.description || goal.name}\nOwner Type: ${goal.ownerType}\nTags: ${goal.tags?.join(', ') || 'none'}\n`;
      })
      .join('\n---\n');

    const prompt = composePrompt({
      state: {
        text: message.content.text || '',
        availableGoals: goalsText,
      },
      template: extractGoalTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    // Parse XML from the text results
    const parsedResult = parseKeyValueXml(result) as GoalSelection | null;

    if (!parsedResult || typeof parsedResult.isFound === 'undefined') {
      logger.error('Failed to parse valid goal selection information from XML');
      return { goalId: '', goalName: '', isFound: false };
    }

    // Convert string 'true'/'false' to boolean and handle 'null' strings
    const finalResult: GoalSelection = {
      goalId: parsedResult.goalId === 'null' ? '' : String(parsedResult.goalId || ''),
      goalName: parsedResult.goalName === 'null' ? '' : String(parsedResult.goalName || ''),
      isFound: String(parsedResult.isFound) === 'true',
    };

    return finalResult;
  } catch (error) {
    logger.error('Error extracting goal selection information:', error);
    return { goalId: '', goalName: '', isFound: false };
  }
}

/**
 * Extracts what updates the user wants to make to the goal
 */
async function extractGoalUpdate(
  runtime: IAgentRuntime,
  message: Memory,
  goal: GoalData
): Promise<GoalUpdate | null> {
  try {
    // Format goal details for the prompt
    let goalDetails = `Name: ${goal.name}\n`;
    if (goal.description) goalDetails += `Description: ${goal.description}\n`;
    goalDetails += `Owner Type: ${goal.ownerType}\n`;
    goalDetails += `Created: ${goal.createdAt?.toLocaleDateString() || 'Unknown'}\n`;

    const prompt = composePrompt({
      state: {
        text: message.content.text || '',
        goalDetails,
      },
      template: extractUpdateTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    // Parse XML from the text results
    const parsedUpdate = parseKeyValueXml(result) as GoalUpdate | null;

    // Validate the parsed update has at least one property
    if (!parsedUpdate || Object.keys(parsedUpdate).length === 0) {
      logger.error('Failed to extract valid goal update information from XML');
      return null;
    }

    // Return only valid fields
    const finalUpdate: GoalUpdate = {};
    if (parsedUpdate.name) finalUpdate.name = String(parsedUpdate.name);
    if (parsedUpdate.description) finalUpdate.description = String(parsedUpdate.description);

    // Return null if no valid fields remain
    if (Object.keys(finalUpdate).length === 0) {
      logger.warn('No valid update fields found after parsing XML.');
      return null;
    }

    return finalUpdate;
  } catch (error) {
    logger.error('Error extracting goal update information:', error);
    return null;
  }
}

/**
 * The UPDATE_GOAL action allows users to modify an existing goal.
 */
export const updateGoalAction: Action = {
  name: 'UPDATE_GOAL',
  similes: ['EDIT_GOAL', 'MODIFY_GOAL', 'CHANGE_GOAL', 'REVISE_GOAL'],
  description: "Updates an existing goal's name or description.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if any active goals exist
    try {
      const dataService = createGoalDataService(runtime);

      // Check both agent and entity goals
      const agentGoalCount = await dataService.countGoals('agent', runtime.agentId, false);
      const entityGoalCount = message.entityId
        ? await dataService.countGoals('entity', message.entityId as UUID, false)
        : 0;

      return agentGoalCount + entityGoalCount > 0;
    } catch (error) {
      logger.error('Error validating UPDATE_GOAL action:', error);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    try {
      if (!state) {
        if (callback) {
          await callback({
            text: 'Unable to process request without state context.',
            actions: ['UPDATE_GOAL_ERROR'],
            source: message.content.source,
          });
        }
        return;
      }

      const dataService = createGoalDataService(runtime);

      // Get all active goals (both agent and entity)
      const agentGoals = await dataService.getGoals({
        ownerType: 'agent',
        ownerId: runtime.agentId,
        isCompleted: false,
      });

      const entityGoals = message.entityId
        ? await dataService.getGoals({
            ownerType: 'entity',
            ownerId: message.entityId as UUID,
            isCompleted: false,
          })
        : [];

      const availableGoals = [...agentGoals, ...entityGoals];

      if (availableGoals.length === 0) {
        if (callback) {
          await callback({
            text: 'There are no active goals to update. Would you like to create a new goal?',
            actions: ['UPDATE_GOAL_NO_GOALS'],
            source: message.content.source,
          });
        }
        return;
      }

      // Phase 1: Extract which goal to update
      const goalSelection = await extractGoalSelection(runtime, message, availableGoals);
      if (!goalSelection.isFound) {
        if (callback) {
          await callback({
            text:
              "I couldn't determine which goal you want to update. Could you be more specific? Here are the current goals:\n\n" +
              availableGoals.map((goal) => `- ${goal.name} (${goal.ownerType} goal)`).join('\n'),
            actions: ['UPDATE_GOAL_NOT_FOUND'],
            source: message.content.source,
          });
        }
        return;
      }

      const goal = availableGoals.find((g) => g.id === goalSelection.goalId);
      if (!goal) {
        if (callback) {
          await callback({
            text: `I couldn't find a goal matching "${goalSelection.goalName}". Please try again with the exact goal name.`,
            actions: ['UPDATE_GOAL_NOT_FOUND'],
            source: message.content.source,
          });
        }
        return;
      }

      // Phase 2: Extract what updates to make
      const update = await extractGoalUpdate(runtime, message, goal);
      if (!update) {
        if (callback) {
          await callback({
            text: `I couldn't determine what changes you want to make to "${goal.name}". You can update the goal's name or description.`,
            actions: ['UPDATE_GOAL_INVALID_UPDATE'],
            source: message.content.source,
          });
        }
        return;
      }

      // Phase 3: Apply the update
      await dataService.updateGoal(goal.id, update);

      const ownerText = goal.ownerType === 'agent' ? 'Agent' : 'User';
      const updateText: string[] = [];
      if (update.name) updateText.push(`name to "${update.name}"`);
      if (update.description) updateText.push(`description to "${update.description}"`);

      if (callback) {
        await callback({
          text: `✓ ${ownerText} goal updated: Changed ${updateText.join(' and ')}.`,
          actions: ['UPDATE_GOAL_SUCCESS'],
          source: message.content.source,
        });
      }
    } catch (error) {
      logger.error('Error in updateGoal handler:', error);
      if (callback) {
        await callback({
          text: 'I encountered an error while trying to update your goal. Please try again.',
          actions: ['UPDATE_GOAL_ERROR'],
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
          text: 'Update my French learning goal to be about Spanish instead',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✓ User goal updated: Changed name to "Learn Spanish fluently".',
          actions: ['UPDATE_GOAL_SUCCESS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Change the description of my marathon goal to include a specific time target',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✓ User goal updated: Changed description to "Complete a marathon in under 4 hours".',
          actions: ['UPDATE_GOAL_SUCCESS'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default updateGoalAction;
