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
import { RolodexService, type ContactInfo } from '../services/RolodexService';

const updateContactTemplate = `# Update Contact Information

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact update information from the message:
1. Who to update (name or entity reference)
2. What fields to update (categories, tags, preferences, notes, custom fields)
3. Whether to add to or replace existing values

## Current Date/Time
{{currentDateTime}}

## Response Format
<response>
<contactName>Name of the contact to update</contactName>
<operation>add_to or replace</operation>
<categories>comma-separated list of categories</categories>
<tags>comma-separated list of tags</tags>
<preferences>key1:value1,key2:value2</preferences>
<customFields>field1:value1,field2:value2</customFields>
<notes>Any additional notes</notes>
</response>`;

export const updateContactAction: Action = {
  name: 'UPDATE_CONTACT',
  similes: ['EDIT_CONTACT', 'MODIFY_CONTACT', 'CHANGE_CONTACT'],
  description: 'Updates an existing contact in the rolodex',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const hasService = !!(await runtime.getService('rolodex'));
    const hasIntent = message.content.text
      ?.toLowerCase()
      .match(/update|edit|modify|change|add.*to|remove.*from/);
    return hasService && !!hasIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult | void> => {
    try {
      const rolodexService = (await runtime.getService('rolodex')) as RolodexService;
      if (!rolodexService) {
        throw new Error('RolodexService not available');
      }

      // Compose the prompt
      const updateState = {
        ...state,
        message: message.content.text,
        senderName: state?.senderName || 'User',
        senderId: message.entityId,
        currentDateTime: new Date().toISOString(),
      };

      const prompt = composePromptFromState({
        state: updateState as State,
        template: updateContactTemplate,
      });

      // Get LLM response
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseKeyValueXml(response) as Record<string, unknown> | null;
      const contactName = parsed?.contactName != null ? String(parsed.contactName) : '';

      if (!parsed || !contactName) {
        logger.warn('[UpdateContact] No contact name provided');
        await callback?.({
          text: "I couldn't determine which contact to update. Please specify the contact name.",
        });
        return;
      }

      // Find the contact entity
      const contacts = await rolodexService.searchContacts({ searchTerm: contactName });

      if (contacts.length === 0) {
        await callback?.({
          text: `I couldn't find a contact named "${contactName}" in the rolodex.`,
        });
        return;
      }

      const contact = contacts[0];
      const operation = (parsed.operation != null ? String(parsed.operation) : 'replace') as 'add_to' | 'replace';

      // Prepare update data
      const updateData: Partial<ContactInfo> = {};

      // Handle categories
      if (parsed.categories != null) {
        const newCategories = String(parsed.categories)
          .split(',')
          .map((c: string) => c.trim())
          .filter(Boolean);
        if (operation === 'add_to' && contact.categories) {
          updateData.categories = [...new Set([...contact.categories, ...newCategories])];
        } else {
          updateData.categories = newCategories;
        }
      }

      // Handle tags
      if (parsed.tags != null) {
        const newTags = String(parsed.tags)
          .split(',')
          .map((t: string) => t.trim())
          .filter(Boolean);
        if (operation === 'add_to' && contact.tags) {
          updateData.tags = [...new Set([...contact.tags, ...newTags])];
        } else {
          updateData.tags = newTags;
        }
      }

      // Handle preferences
      if (parsed.preferences != null) {
        const newPrefs: Record<string, string> = {};
        String(parsed.preferences).split(',').forEach((pref: string) => {
          const [key, value] = pref.split(':').map((s: string) => s.trim());
          if (key && value) newPrefs[key] = value;
        });

        if (operation === 'add_to' && contact.preferences) {
          updateData.preferences = { ...contact.preferences, ...newPrefs };
        } else {
          updateData.preferences = newPrefs;
        }
      }

      // Handle custom fields
      if (parsed.customFields != null) {
        const newFields: Record<string, string> = {};
        String(parsed.customFields).split(',').forEach((field: string) => {
          const [key, value] = field.split(':').map((s: string) => s.trim());
          if (key && value) newFields[key] = value;
        });

        if (operation === 'add_to' && contact.customFields) {
          updateData.customFields = { ...contact.customFields, ...newFields };
        } else {
          updateData.customFields = newFields;
        }
      }

      // Update the contact
      const updated = await rolodexService.updateContact(contact.entityId, updateData);

      if (updated) {
        const responseText = `I've updated ${contactName}'s contact information. ${
          updateData.categories ? `Categories: ${updateData.categories.join(', ')}. ` : ''
        }${updateData.tags ? `Tags: ${updateData.tags.join(', ')}. ` : ''}`;

        await callback?.({ text: responseText });

        logger.info(`[UpdateContact] Updated contact ${contact.entityId}`);

        return {
          success: true,
          values: { contactId: contact.entityId, ...updateData },
          data: { success: true, updatedFields: Object.keys(updateData) },
          text: responseText,
        };
      } else {
        throw new Error('Failed to update contact');
      }
    } catch (error) {
      logger.error('[UpdateContact] Error:', error instanceof Error ? error.message : String(error));
      await callback?.({
        text: `I encountered an error while updating the contact. ${error instanceof Error ? error.message : 'Please try again.'}`,
      });
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Update John Doe and add the tech tag',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've updated John Doe's contact information. Tags: tech.",
          actions: ['UPDATE_CONTACT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Change Sarah to a VIP contact and set her timezone to PST',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've updated Sarah's contact information. Categories: vip.",
          actions: ['UPDATE_CONTACT'],
        },
      },
    ],
  ],
};
