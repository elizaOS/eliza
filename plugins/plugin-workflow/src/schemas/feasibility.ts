export const feasibilitySchema = {
  type: 'object',
  properties: {
    feasible: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['feasible', 'reason'],
};
