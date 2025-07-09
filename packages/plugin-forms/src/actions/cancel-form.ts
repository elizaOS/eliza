import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  elizaLogger,
  type UUID,
} from '@elizaos/core';
import { FormsService } from '../services/forms-service';

/**
 * CancelFormAction cancels an active form.
 */
export const cancelFormAction: Action = {
  name: 'CANCEL_FORM',
  similes: ['ABORT_FORM', 'STOP_FORM', 'QUIT_FORM', 'EXIT_FORM'],
  description: 'Cancels an active form',

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

    const text = message.content.text?.toLowerCase() || '';

    // Check if user wants to cancel a form
    const wantsCancel =
      text.includes('cancel') ||
      text.includes('stop') ||
      text.includes('abort') ||
      text.includes('quit') ||
      text.includes('exit') ||
      text.includes('nevermind') ||
      text.includes('never mind') ||
      (text.includes("don't") && text.includes('want'));

    return wantsCancel;
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
          text: 'No active forms to cancel.',
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
        // For now, cancel the first active form
        targetForm = activeForms[0];
      }

      const formId = targetForm.id;

      elizaLogger.debug(`Cancelling form ${formId}`);

      // Cancel the form
      const success = await formsService.cancelForm(formId);

      if (success) {
        await callback?.({
          text: `I've cancelled the form. Is there anything else I can help you with?`,
          actions: ['CANCEL_FORM'],
          data: {
            formId,
          },
        });

        return {
          success: true,
          data: {
            formId,
          },
        };
      } else {
        await callback?.({
          text: 'I was unable to cancel the form. It may have already been completed or cancelled.',
          actions: [],
        });

        return {
          success: false,
          message: 'Failed to cancel form',
        };
      }
    } catch (error) {
      elizaLogger.error('Error in CANCEL_FORM action:', error);
      await callback?.({
        text: 'An error occurred while cancelling the form.',
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
          text: 'Actually, cancel the form',
        },
      },
      {
        name: 'assistant',
        content: {
          text: "I've cancelled the contact form. Is there anything else I can help you with?",
          actions: ['CANCEL_FORM'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: "Never mind, I don't want to fill this out",
        },
      },
      {
        name: 'assistant',
        content: {
          text: "I've cancelled the form. Is there anything else I can help you with?",
          actions: ['CANCEL_FORM'],
        },
      },
    ],
  ] as const,
};
