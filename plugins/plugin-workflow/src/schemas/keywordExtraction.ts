export const keywordExtractionSchema = {
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 5 relevant keywords or phrases',
    },
  },
  required: ['keywords'],
};
