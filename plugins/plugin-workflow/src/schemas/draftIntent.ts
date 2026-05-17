/**
 * JSON schema for LLM draft intent classification output
 */
export const draftIntentSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['confirm', 'cancel', 'modify', 'new'],
    },
    modificationRequest: {
      type: 'string',
      description: 'What the user wants changed (only for modify intent)',
    },
    reason: {
      type: 'string',
      description: 'Brief explanation of the classification',
    },
  },
  required: ['intent', 'modificationRequest', 'reason'],
};
