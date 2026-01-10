import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  logger,
  type UUID,
} from '@elizaos/core';
import { FormsService } from '../services/forms-service';

/**
 * UpdateFormAction processes user messages to extract form field values
 * and updates the active form accordingly.
 */
export const updateFormAction: Action = {
  name: 'UPDATE_FORM',
  similes: ['FILL_FORM', 'SUBMIT_FORM', 'COMPLETE_FORM', 'FORM_INPUT'],
  description: 'Updates an active form with values extracted from the user message',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    // Check if forms service is available
    const formsService = runtime.getService<FormsService>('forms');
    if (!formsService) {
      return false;
    }

    // Check if there are any active forms
    const activeForms = await formsService.listForms('active');
    if (activeForms.length === 0) {
      return false;
    }

    // Check if the message seems to contain form input
    const text = message.content.text?.toLowerCase() || '';

    // Simple heuristics to detect if user is providing form input
    // This could be enhanced with more sophisticated detection
    const containsFormInput =
      text.includes('my name is') ||
      text.includes('i am') ||
      text.includes('@') || // Email
      !!text.match(/\d{2,}/) || // Numbers
      text.length > 5; // Minimum length for meaningful input

    return containsFormInput;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    try {
      const formsService = runtime.getService<FormsService>('forms');
      if (!formsService) {
        throw new Error('Forms service not available');
      }

      // Get active forms
      const activeForms = await formsService.listForms('active');
      if (activeForms.length === 0) {
        await callback?.({
          text: 'No active forms to update.',
          actions: [],
        });
        return;
      }

      // Check if a specific form ID was provided
      let targetForm;
      const specifiedFormId =
        options?.formId || state?.data?.activeFormId || state?.values?.activeFormId;

      if (specifiedFormId) {
        // Find the specific form
        targetForm = activeForms.find((f) => f.id === specifiedFormId);
        if (!targetForm) {
          await callback?.({
            text: 'The specified form is no longer active.',
            actions: [],
          });
          return;
        }
      } else {
        // For now, update the first active form
        // In the future, we could use context to determine which form to update
        targetForm = activeForms[0];
      }

      const formId = targetForm.id as UUID;

      logger.debug(`Updating form ${formId} with user message`);

      // Update the form with the message
      const result = await formsService.updateForm(formId, message);

      if (!result.success) {
        await callback?.({
          text: result.message || 'Failed to update form.',
          actions: [],
        });
        return {
          success: false,
          error: result.message || 'Failed to update form.',
        };
      }

      // Prepare response based on update result
      let responseText = '';

      if (result.updatedFields && result.updatedFields.length > 0) {
        responseText += `Updated ${result.updatedFields.length} field(s). `;
      }

      if (result.formCompleted) {
        responseText += 'Form completed successfully! ';
      } else if (result.stepCompleted) {
        responseText += result.message || '';
      } else {
        responseText += result.message || '';
      }

      // Add form state to response
      const form = result.form;
      if (form && form.status === 'active') {
        const currentStep = form.steps[form.currentStepIndex];
        if (currentStep) {
          const remainingRequired = currentStep.fields.filter(
            (f) => !f.optional && (!f.value || f.value === '')
          );

          if (remainingRequired.length > 0) {
            responseText += '\n\nRemaining required fields in current step:';
            remainingRequired.forEach((field) => {
              responseText += `\n- ${field.label}${field.description ? `: ${field.description}` : ''}`;
            });
          }
        }
      }

      await callback?.({
        text: responseText.trim(),
        actions: ['UPDATE_FORM'],
        data: {
          formId: form?.id,
          formName: form?.name,
          currentStep: form?.currentStepIndex,
          totalSteps: form?.steps.length,
          status: form?.status,
          updatedFields: result.updatedFields,
        },
      });

      return {
        success: true,
        data: {
          formId: form?.id,
          updatedFields: result.updatedFields,
          formCompleted: result.formCompleted,
          stepCompleted: result.stepCompleted,
        },
      };
    } catch (error) {
      logger.error('Error in UPDATE_FORM action:', error);
      await callback?.({
        text: 'An error occurred while updating the form. Please try again.',
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
          text: "I'll help you with the contact form. Please provide your name to get started.",
          actions: ['CREATE_FORM'],
        },
      },
      {
        name: 'user',
        content: {
          text: 'My name is John Smith',
        },
      },
      {
        name: 'assistant',
        content: {
          text: "Thank you, John Smith. I've recorded your name. Now, please provide your email address.",
          actions: ['UPDATE_FORM'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'john.smith@example.com',
        },
      },
      {
        name: 'assistant',
        content: {
          text: "Perfect! I've recorded your email as john.smith@example.com. The last field is optional - would you like to include a message?",
          actions: ['UPDATE_FORM'],
        },
      },
    ],
  ],
};
