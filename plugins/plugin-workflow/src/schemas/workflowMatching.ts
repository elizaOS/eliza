export const workflowMatchingSchema = {
  type: 'object',
  properties: {
    matchedWorkflowId: {
      type: 'string',
      nullable: true,
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low', 'none'],
    },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          score: { type: 'number' },
        },
        required: ['id', 'name', 'score'],
      },
    },
    reason: {
      type: 'string',
    },
  },
  required: ['matchedWorkflowId', 'confidence', 'matches', 'reason'],
};
