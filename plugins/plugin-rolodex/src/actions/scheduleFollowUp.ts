import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  parseKeyValueXml,
  composePromptFromState,
  findEntityByName,
  asUUID,
  type HandlerCallback,
  ModelType,
  type ActionResult,
} from '@elizaos/core';
import { RolodexService, FollowUpService } from '../services';

const scheduleFollowUpTemplate = `# Schedule Follow-up

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the follow-up scheduling information from the message:
1. Who to follow up with (name or entity reference)
2. When to follow up (date/time or relative time like "tomorrow", "next week")
3. Reason for the follow-up
4. Priority (high, medium, low)
5. Any specific message or notes

## Current Date/Time
{{currentDateTime}}

## Response Format
<response>
<contactName>Name of the contact to follow up with</contactName>
<entityId>ID if known, otherwise leave empty</entityId>
<scheduledAt>ISO datetime for the follow-up</scheduledAt>
<reason>Reason for the follow-up</reason>
<priority>high, medium, or low</priority>
<message>Optional message or notes for the follow-up</message>
</response>`;

export const scheduleFollowUpAction: Action = {
  name: 'SCHEDULE_FOLLOW_UP',
  description: 'Schedule a follow-up reminder for a contact',
  similes: [
    'follow up with',
    'remind me to contact',
    'schedule a check-in',
    'set a reminder for',
    'follow up on',
    'check back with',
    'reach out to',
    'schedule follow-up',
    'remind me about',
  ],
  examples: [
    [
      {
        name: '{{name1}}',
        content: { text: 'Remind me to follow up with John next week about the project' },
      },
      {
        name: '{{name2}}',
        content: { text: "I've scheduled a follow-up with John for next week about the project." },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'Schedule a follow-up with Sarah tomorrow at 2pm' },
      },
      {
        name: '{{name2}}',
        content: { text: "I've scheduled a follow-up with Sarah for tomorrow at 2:00 PM." },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'Follow up with the VIP client in 3 days' },
      },
      {
        name: '{{name2}}',
        content: { text: "I've scheduled a follow-up with the VIP client in 3 days." },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Check if both services are available
    const rolodexService = (await runtime.getService('rolodex')) as RolodexService;
    const followUpService = (await runtime.getService('follow_up')) as FollowUpService;

    if (!rolodexService || !followUpService) {
      logger.warn('[ScheduleFollowUp] Required services not available');
      return false;
    }

    // Check if message contains intent to schedule follow-up
    const followUpKeywords = [
      'follow up',
      'followup',
      'remind',
      'check in',
      'check back',
      'reach out',
      'schedule',
    ];
    const messageText = message.content.text?.toLowerCase() || '';

    return followUpKeywords.some((keyword) => messageText.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult | void> => {
    const rolodexService = (await runtime.getService('rolodex')) as RolodexService;
    const followUpService = (await runtime.getService('follow_up')) as FollowUpService;

    if (!rolodexService || !followUpService) {
      throw new Error('Required services not available');
    }

    try {
      // Build proper state for prompt composition
      if (!state) {
        state = {
          values: {},
          data: {},
          text: '',
        };
      }

      // Add our values to the state
      state.values = {
        ...state.values,
        message: message.content.text,
        senderId: message.entityId,
        senderName: state.values?.senderName || 'User',
        currentDateTime: new Date().toISOString(),
      };

      // Compose prompt to extract follow-up information
      const prompt = composePromptFromState({
        state,
        template: scheduleFollowUpTemplate,
      });

      // Use LLM to extract follow-up details
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseKeyValueXml(response) as Record<string, unknown> | null;
      const contactName = parsedResponse?.contactName != null ? String(parsedResponse.contactName) : '';
      const entityIdStr = parsedResponse?.entityId != null ? String(parsedResponse.entityId) : '';
      if (!parsedResponse || (!contactName && !entityIdStr)) {
        logger.warn('[ScheduleFollowUp] Failed to parse follow-up information from response');
        throw new Error('Could not extract follow-up information');
      }

      // Determine entity ID
      let entityId = entityIdStr ? asUUID(entityIdStr) : null;

      // If no entity ID provided, try to find by name
      if (!entityId && contactName) {
        const entity = await findEntityByName(runtime, message, state);

        if (entity) {
          entityId = entity.id as import('@elizaos/core').UUID;
        } else {
          throw new Error(`Contact "${contactName}" not found in rolodex`);
        }
      }

      if (!entityId) {
        throw new Error('Could not determine contact to follow up with');
      }

      // Verify contact exists in rolodex
      const contact = await rolodexService.getContact(entityId);
      if (!contact) {
        throw new Error('Contact not found in rolodex. Please add them first.');
      }

      // Parse scheduled time
      const scheduledAtVal = parsedResponse.scheduledAt != null ? String(parsedResponse.scheduledAt) : '';
      const scheduledAt = new Date(scheduledAtVal);
      if (isNaN(scheduledAt.getTime())) {
        throw new Error('Invalid follow-up date/time');
      }

      // Schedule the follow-up
      const task = await followUpService.scheduleFollowUp(
        entityId,
        scheduledAt,
        parsedResponse.reason != null ? String(parsedResponse.reason) : 'Follow-up',
        parsedResponse.priority != null ? String(parsedResponse.priority) : 'medium',
        parsedResponse.message != null ? String(parsedResponse.message) : undefined,
      );

      logger.info(
        `[ScheduleFollowUp] Scheduled follow-up for ${contactName} at ${scheduledAt.toISOString()}`,
      );

      // Prepare response
      const responseText = `I've scheduled a follow-up with ${contactName} for ${scheduledAt.toLocaleString()}. ${
        parsedResponse.reason ? `Reason: ${String(parsedResponse.reason)}` : ''
      }`;

      if (callback) {
        await callback({ text: responseText });
      }

      return {
        success: true,
        values: {
          contactId: entityId,
          taskId: task.id,
        },
        data: {
          contactId: entityId,
          contactName,
          scheduledAt: scheduledAt.toISOString(),
          taskId: task.id,
          reason: parsedResponse.reason != null ? String(parsedResponse.reason) : undefined,
          priority: parsedResponse.priority != null ? String(parsedResponse.priority) : undefined,
        },
        text: responseText,
      };
    } catch (error) {
      logger.error('[ScheduleFollowUp] Error scheduling follow-up:', error instanceof Error ? error.message : String(error));

      const errorText = `I couldn't schedule the follow-up. ${
        error instanceof Error ? error.message : 'Please try again.'
      }`;

      if (callback) {
        await callback({ text: errorText });
      }

      return {
        success: false,
        values: {
          contactId: runtime.agentId,
          taskId: null,
        },
        data: {
          contactId: runtime.agentId,
          contactName: 'Error',
          scheduledAt: null,
          taskId: null,
          reason: errorText,
          priority: null,
        },
        text: errorText,
      };
    }
  },
};
