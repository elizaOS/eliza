import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { FormsService } from '../services/forms-service';
import type { Form } from '../types';

/**
 * Provider that exposes active forms context to the agent
 */
export const formsProvider: Provider = {
  name: 'FORMS_CONTEXT',
  description: 'Provides context about active forms and their current state',
  dynamic: true, // Only called when needed
  position: 50, // Mid-priority

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const formsService = runtime.getService<FormsService>('forms');
    if (!formsService) {
      return {
        text: 'Forms service is not available.',
        values: {},
        data: {},
      };
    }

    try {
      // Get all active forms for this agent
      const activeForms = await formsService.listForms('active');

      if (activeForms.length === 0) {
        return {
          text: '',
          values: {},
          data: {},
        };
      }

      // Format active forms for context
      let contextText = '[FORMS]\n';
      const formsData: Form[] = [];

      for (const form of activeForms) {
        const currentStep = form.steps[form.currentStepIndex];
        contextText += `\nActive Form: ${form.name} (ID: ${form.id})\n`;
        contextText += `Current Step: ${currentStep.name || currentStep.id}\n`;

        // Show completed fields (mask secrets)
        const completedFields = currentStep.fields.filter((f) => f.value !== undefined);
        if (completedFields.length > 0) {
          contextText += 'Completed fields:\n';
          completedFields.forEach((field) => {
            const displayValue = field.secret ? '[SECRET]' : field.value;
            contextText += `  - ${field.label}: ${displayValue}\n`;
          });
        }

        // Show remaining required fields
        const remainingRequired = currentStep.fields.filter(
          (f) => !f.optional && f.value === undefined
        );
        if (remainingRequired.length > 0) {
          contextText += 'Required fields:\n';
          remainingRequired.forEach((field) => {
            contextText += `  - ${field.label}${field.description ? ` (${field.description})` : ''}\n`;
          });
        }

        // Show optional fields
        const optionalFields = currentStep.fields.filter(
          (f) => f.optional && f.value === undefined
        );
        if (optionalFields.length > 0) {
          contextText += 'Optional fields:\n';
          optionalFields.forEach((field) => {
            contextText += `  - ${field.label}${field.description ? ` (${field.description})` : ''}\n`;
          });
        }

        contextText += `Progress: Step ${form.currentStepIndex + 1} of ${form.steps.length}\n`;
        formsData.push(form);
      }

      return {
        text: contextText,
        values: {
          activeFormsCount: activeForms.length,
        },
        data: {
          forms: formsData,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        text: `Error retrieving forms context: ${errorMessage}`,
        values: {},
        data: {},
      };
    }
  },
};
