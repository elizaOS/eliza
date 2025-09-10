// Shared test definitions for both backend and frontend
export const TEST_DEFINITIONS = {
  testSuite: 'action-benchmarks',
  tests: [
    {
      testId: 'retail-full-exchange-flow',
      name: 'Retail Full Exchange Flow',
      category: 'retail',
      description:
        'Complete customer exchange workflow with authentication and multiple item exchanges',
      steps: [
        {
          stepId: 1,
          userMessage:
            "Hello there! I've just received my order with the number W2378156, and I'd like to inquire about making a couple of exchanges.",
          expectedActions: [],
          expectedPatterns: ['authenticate', 'identity', 'email', 'provide'],
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: false,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should ask for authentication details like email, name, or order information',
          },
        },
        {
          stepId: 2,
          userMessage:
            'Apologies, but I am not comfortable sharing my email in chat. However, I can confirm the name on the order is Yusuf Rossi and shipping zip code as 19122. Would that be sufficient?',
          expectedActions: ['FIND_USER_ID_BY_NAME_ZIP'],
          expectedPatterns: ['thanks for verifying', 'identity', 'yusuf'],
          requireActions: true,
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: true,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should confirm successful authentication using name and zip code',
          },
        },
        {
          stepId: 3,
          userMessage:
            "Absolutely. Starting with the mechanical keyboard from this order, I'd like to exchange it for a similar one but with clicky switches. It's also important that it has RGB backlighting and that it's a full-size model.",
          expectedActions: ['GET_ORDER_DETAILS', 'GET_PRODUCT_DETAILS'],
          expectedPatterns: [
            'mechanical keyboard',
            'variants',
            'clicky switches',
            'RGB',
            'full-size',
          ],
          requireActions: true,
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: false,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should provide keyboard options with clicky switches, RGB, and full-size features',
          },
        },
        {
          stepId: 4,
          userMessage:
            "Understandable. Hmm, in that case, I think I'll prioritize the clicky switches and go with the full-size model with no backlight, that is, the Item ID: 7706410293.",
          expectedActions: [],
          expectedPatterns: [
            '7706410293',
            'clicky',
            'full size',
            'no backlight',
            'price difference',
          ],
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: false,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should confirm the selected keyboard (Item ID: 7706410293) and mention any price difference',
          },
        },
        {
          stepId: 5,
          userMessage:
            "Yes, I can confirm that this exchange is satisfactory. The clicky switches are far more significant to me than the backlight. Let's proceed with this exchange by using credit card.",
          expectedActions: ['EXCHANGE_DELIVERED_ORDER_ITEMS'],
          expectedPatterns: [
            'exchange requested',
            'successfully processed',
            'price difference',
            'email with instructions',
          ],
          requireActions: true,
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: true,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should confirm successful exchange processing and mention return instructions',
          },
        },
        {
          stepId: 6,
          userMessage:
            "Yes, there's another item I'd like to discuss for exchange. Specifically, the smart thermostat from my order; it's currently compatible with Apple HomeKit, but I'd like to exchange it for one that's compatible with Google Home.",
          expectedActions: ['GET_PRODUCT_DETAILS'],
          expectedPatterns: ['smart thermostat', 'variants', 'Google Assistant', 'compatible'],
          requireActions: true,
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: true,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should provide thermostat options compatible with Google Home/Assistant',
          },
        },
        {
          stepId: 7,
          userMessage:
            "That item fits the particular requirement I had in mind. Yes, let's proceed with the exchange for the thermostat.",
          expectedActions: [],
          expectedPatterns: [
            'details for the exchange',
            'Apple HomeKit',
            'Google Assistant',
            'price difference',
          ],
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: false,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should provide exchange details for switching from Apple HomeKit to Google Assistant thermostat',
          },
        },
        {
          stepId: 8,
          userMessage:
            'Yes, I confirm that I would like to exchange the thermostat as well. The compatibility with Google Assistant is really crucial for me, so it seems like the right choice.',
          expectedActions: ['EXCHANGE_DELIVERED_ORDER_ITEMS', 'TRANSFER_TO_HUMAN_AGENTS'],
          expectedPatterns: [
            'Error',
            'non-delivered',
            'cannot be exchanged',
            'Transfer successful',
          ],
          requireActions: true,
          waitForFinalResponse: true,
          actionEvaluation: {
            requiresOrder: false,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              'The response should handle the exchange error and transfer to human agents if needed',
          },
        },
      ],
    },
    {
      testId: 'hello-basic',
      name: 'Just Type Hello',
      category: 'typing',
      steps: [
        {
          stepId: 1,
          userMessage: "Please type 'hello'",
          expectedActions: ['TYPE_H', 'TYPE_E', 'TYPE_L', 'TYPE_L', 'TYPE_O'],
          actionEvaluation: {
            requiresOrder: true,
          },
          responseEvaluation: {
            enabled: false,
          },
        },
      ],
    },
    {
      testId: 'hello-sentence',
      name: 'Type Hello And Make Sentence',
      category: 'typing',
      steps: [
        {
          stepId: 1,
          userMessage: "Type 'hello' and then use hello to make a greeting sentence",
          expectedActions: ['TYPE_H', 'TYPE_E', 'TYPE_L', 'TYPE_L', 'TYPE_O'],
          actionEvaluation: {
            requiresOrder: true,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              "The response should be a complete greeting sentence that contains the word 'hello' and sounds natural as a greeting to someone.",
          },
        },
      ],
    },
    {
      testId: 'multi-step-conversation',
      name: 'Multi-Step Typing Challenge',
      category: 'typing',
      steps: [
        {
          stepId: 1,
          userMessage: "Please type 'hi'",
          expectedActions: ['TYPE_H', 'TYPE_I'],
          actionEvaluation: {
            requiresOrder: true,
          },
          responseEvaluation: {
            enabled: false,
          },
        },
        {
          stepId: 2,
          userMessage: "Now type 'bye'",
          expectedActions: ['TYPE_B', 'TYPE_Y', 'TYPE_E'],
          actionEvaluation: {
            requiresOrder: true,
          },
          responseEvaluation: {
            enabled: false,
          },
        },
        {
          stepId: 3,
          userMessage: "Finally, use both 'hi' and 'bye' to create a conversation sentence",
          expectedActions: [],
          actionEvaluation: {
            requiresOrder: false,
          },
          responseEvaluation: {
            enabled: true,
            criteria:
              "The response should be a natural conversation sentence that incorporates both the words 'hi' and 'bye' in a meaningful way.",
          },
        },
      ],
    },
  ],
} as const;

export type TestDefinitions = typeof TEST_DEFINITIONS;
