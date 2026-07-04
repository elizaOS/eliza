/** JSON schema for the keyword-extraction LLM call: up to five node-search keywords. */
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
