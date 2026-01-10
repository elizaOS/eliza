import { Action, IAgentRuntime, Memory, State, HandlerCallback, logger } from '@elizaos/core';
import { FormsService } from '../services/forms-service';

/**
 * CreateFormAction initializes a new form from a template or custom definition.
 */
export const createFormAction: Action = {
  name: 'CREATE_FORM',
  similes: ['START_FORM', 'NEW_FORM', 'INIT_FORM', 'BEGIN_FORM'],
  description: 'Creates a new form from a template or custom definition',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    // Check if forms service is available
    const formsService = runtime.getService<FormsService>('forms');
    if (!formsService) {
      return false;
    }

    const text = message.content.text?.toLowerCase() || '';

    // Check if user wants to create a form
    const wantsForm =
      text.includes('form') ||
      text.includes('fill out') ||
      text.includes('fill in') ||
      text.includes('questionnaire') ||
      text.includes('survey') ||
      text.includes('contact') ||
      text.includes('application');

    return wantsForm;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    try {
      const formsService = runtime.getService<FormsService>('forms');
      if (!formsService) {
        throw new Error('Forms service not available');
      }

      // Extract form type from message or options
      const text = message.content.text?.toLowerCase() || '';
      const templateName = (options?.template as string) || extractFormType(text) || 'contact'; // Default to contact form

      logger.debug(`Creating form with template: ${templateName}`);

      // Create the form
      const form = await formsService.createForm(templateName, {
        source: 'user_request',
        requestedAt: Date.now(),
      });

      // Get first step information
      const firstStep = form.steps[0];
      const requiredFields = firstStep?.fields.filter((f) => !f.optional) || [];

      let responseText = `I've created a new ${form.name} form for you.`;

      if (form.description) {
        responseText += ` ${form.description}`;
      }

      if (firstStep) {
        responseText += `\n\nLet's start with ${firstStep.name}.`;

        if (requiredFields.length > 0) {
          responseText += '\n\nPlease provide the following information:';
          requiredFields.forEach((field) => {
            responseText += `\n- ${field.label}${field.description ? `: ${field.description}` : ''}`;
          });
        }
      }

      await callback?.({
        text: responseText,
        actions: ['CREATE_FORM'],
        data: {
          formId: form.id,
          formName: form.name,
          totalSteps: form.steps.length,
          currentStep: 0,
        },
      });

      return {
        success: true,
        data: {
          formId: form.id,
          formName: form.name,
          templateUsed: templateName,
        },
      };
    } catch (error) {
      logger.error('Error in CREATE_FORM action:', error);
      await callback?.({
        text: 'I encountered an error while creating the form. Please try again.',
        actions: [],
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },

  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'I need to fill out a contact form',
        },
      },
      {
        name: 'assistant',
        content: {
          text: `I've created a new contact form for you. Basic contact information form

Let's start with Basic Information.

Please provide the following information:
- Name: Your full name
- Email: Your email address`,
          actions: ['CREATE_FORM'],
        },
      },
    ],
  ],
};

/**
 * Extract form type from user message
 */
function extractFormType(text: string): string | null {
  const formTypes: Record<string, string[]> = {
    contact: ['contact', 'reach out', 'get in touch', 'message'],
    feedback: ['feedback', 'review', 'opinion', 'suggestion'],
    application: ['apply', 'application', 'job', 'position'],
    survey: ['survey', 'questionnaire', 'poll'],
    registration: ['register', 'sign up', 'enroll', 'join'],
  };

  for (const [type, keywords] of Object.entries(formTypes)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return type;
    }
  }

  return null;
}
