import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  parseKeyValueXml,
  composePromptFromState,
  type HandlerCallback,
  ModelType,
  type ActionResult,
} from '@elizaos/core';
import { RolodexService } from '../services/RolodexService';

const removeContactTemplate = `# Remove Contact from Rolodex

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact removal information from the message:
1. Who to remove (name or entity reference)
2. Confirmation of the intent to remove

## Response Format
<response>
<contactName>Name of the contact to remove</contactName>
<confirmed>yes or no</confirmed>
</response>`;

export const removeContactAction: Action = {
  name: 'REMOVE_CONTACT',
  similes: ['DELETE_CONTACT', 'REMOVE_FROM_ROLODEX', 'DELETE_FROM_CONTACTS'],
  description: 'Removes a contact from the rolodex',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const hasService = !!runtime.getService('rolodex');
    const hasIntent = message.content.text
      ?.toLowerCase()
      .match(/remove|delete|drop.*contact|remove.*from.*rolodex/);
    return hasService && !!hasIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult | void> => {
    try {
      const rolodexService = runtime.getService('rolodex') as RolodexService;
      if (!rolodexService) {
        throw new Error('RolodexService not available');
      }

      // Compose the prompt
      const removeState = {
        ...state,
        message: message.content.text,
        senderName: state?.senderName || 'User',
        senderId: message.entityId,
      };

      const prompt = composePromptFromState({
        state: removeState as State,
        template: removeContactTemplate,
      });

      // Get LLM response
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseKeyValueXml(response);

      if (!parsed?.contactName) {
        logger.warn('[RemoveContact] No contact name provided');
        await callback?.({
          text: "I couldn't determine which contact to remove. Please specify the contact name.",
        });
        return;
      }

      if (parsed.confirmed !== 'yes') {
        await callback?.({
          text: `To remove ${parsed.contactName} from your contacts, please confirm by saying "yes, remove ${parsed.contactName}".`,
        });
        return;
      }

      // Find the contact
      const contacts = await rolodexService.searchContacts({ searchTerm: parsed.contactName });

      if (contacts.length === 0) {
        await callback?.({
          text: `I couldn't find a contact named "${parsed.contactName}" in the rolodex.`,
        });
        return;
      }

      const contact = contacts[0];

      // Remove the contact
      const removed = await rolodexService.removeContact(contact.entityId);

      if (removed) {
        const responseText = `I've removed ${parsed.contactName} from your contacts.`;
        await callback?.({
          text: responseText,
          actions: ['REMOVE_CONTACT'],
        });

        logger.info(`[RemoveContact] Removed contact ${contact.entityId}`);

        return {
          success: true,
          values: { contactId: contact.entityId },
          data: { success: true },
          text: responseText,
        };
      } else {
        throw new Error('Failed to remove contact');
      }
    } catch (error) {
      logger.error('[RemoveContact] Error:', error instanceof Error ? error.message : String(error));
      await callback?.({
        text: 'I encountered an error while removing the contact. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Remove John Doe from my contacts',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'To remove John Doe from your contacts, please confirm by saying "yes, remove John Doe".',
          actions: ['REMOVE_CONTACT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Yes, remove John Doe',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've removed John Doe from your contacts.",
          actions: ['REMOVE_CONTACT'],
        },
      },
    ],
  ],
};
