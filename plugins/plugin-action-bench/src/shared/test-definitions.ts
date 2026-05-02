// Shared test definitions for both backend and frontend
export const TEST_DEFINITIONS = {
  "testSuite": "action-benchmarks",
  "tests": [
    {
      "testId": "hello-basic",
      "name": "Just Type Hello",
      "steps": [
        {
          "stepId": 1,
          "userMessage": "Please type 'hello'",
          "expectedActions": ["TYPE_H", "TYPE_E", "TYPE_L", "TYPE_L", "TYPE_O"],
          "actionEvaluation": {
            "requiresOrder": true
          },
          "responseEvaluation": {
            "enabled": false
          }
        }
      ]
    },
    {
      "testId": "hello-sentence",
      "name": "Type Hello And Make Sentence",
      "steps": [
        {
          "stepId": 1,
          "userMessage": "Type 'hello' and then use hello to make a greeting sentence",
          "expectedActions": ["TYPE_H", "TYPE_E", "TYPE_L", "TYPE_L", "TYPE_O"],
          "actionEvaluation": {
            "requiresOrder": true
          },
          "responseEvaluation": {
            "enabled": true,
            "criteria": "The response should be a complete greeting sentence that contains the word 'hello' and sounds natural as a greeting to someone."
          }
        }
      ]
    },
    {
      "testId": "multi-step-conversation",
      "name": "Multi-Step Typing Challenge",
      "steps": [
        {
          "stepId": 1,
          "userMessage": "Please type 'hi'",
          "expectedActions": ["TYPE_H", "TYPE_I"],
          "actionEvaluation": {
            "requiresOrder": true
          },
          "responseEvaluation": {
            "enabled": false
          }
        },
        {
          "stepId": 2,
          "userMessage": "Now type 'bye'",
          "expectedActions": ["TYPE_B", "TYPE_Y", "TYPE_E"],
          "actionEvaluation": {
            "requiresOrder": true
          },
          "responseEvaluation": {
            "enabled": false
          }
        },
        {
          "stepId": 3,
          "userMessage": "Finally, use both 'hi' and 'bye' to create a conversation sentence",
          "expectedActions": [],
          "actionEvaluation": {
            "requiresOrder": false
          },
          "responseEvaluation": {
            "enabled": true,
            "criteria": "The response should be a natural conversation sentence that incorporates both the words 'hi' and 'bye' in a meaningful way."
          }
        }
      ]
    }
  ]
} as const;

export type TestDefinitions = typeof TEST_DEFINITIONS;
