import type { Scenario } from './types.js';
import { asUUID } from '@elizaos/core';
import { v4 } from 'uuid';

export const truthVsLieScenario: Scenario = {
  id: 'truth-vs-lie',
  name: 'Truth vs Lie Detection',
  description: 'Test scenario to see if the agent can detect lies vs truthful statements',
  category: 'reasoning',
  tags: ['detection', 'reasoning', 'conversation'],
  
  actors: [
    {
      id: asUUID(v4()),
      name: 'Detective',
      role: 'subject',
      bio: 'An expert detective trying to uncover the truth',
      script: {
        steps: []
      }
    },
    {
      id: asUUID(v4()),
      name: 'Truthful Witness',
      role: 'assistant',
      bio: 'A witness who always tells the truth about the blue vase',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I saw the blue vase on the table in the living room at 3:00 PM',
            timeout: 5000
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          {
            type: 'message',
            content: 'It was definitely blue, not green. I remember clearly.',
            timeout: 5000
          }
        ]
      }
    },
    {
      id: asUUID(v4()),
      name: 'Deceptive Witness',
      role: 'assistant',
      bio: 'A witness who lies about the vase color',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 2000
          },
          {
            type: 'message',
            content: 'Actually, I think the vase was green, not blue',
            timeout: 5000
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          {
            type: 'message',
            content: 'Yes, I\'m certain it was green. The other witness must be mistaken.',
            timeout: 5000
          }
        ]
      }
    }
  ],

  setup: {
    roomType: 'group',
    roomName: 'Accident Investigation',
    context: 'You are investigating a car accident. Interview the witnesses to determine what really happened and who is telling the truth.',
    initialMessages: [
      {
        id: 'context-msg',
        content: 'Welcome to the accident investigation. Two witnesses are here to give their statements about a collision between a red sedan and blue truck at the intersection of Main St and Oak Ave.',
        sender: 'system',
        timestamp: Date.now()
      }
    ]
  },

  execution: {
    maxDuration: 300000, // 5 minutes
    maxSteps: 50,
    stopConditions: [
      {
        type: 'message_count',
        value: 25,
        description: 'Stop after 25 total messages to prevent infinite loops'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'detected-liar',
        type: 'llm',
        description: 'Agent correctly identified the deceptive witness',
        config: {
          criteria: 'The agent correctly identified Mike as the deceptive witness and Sarah as truthful, or expressed suspicion about Mike\'s inconsistent statements'
        },
        weight: 3
      },
      {
        id: 'identified-inconsistencies',
        type: 'llm', 
        description: 'Agent identified specific inconsistencies in testimony',
        config: {
          criteria: 'The agent pointed out specific inconsistencies in Mike\'s story (time, car colors, sequence of events)'
        },
        weight: 2
      },
      {
        id: 'asked-clarifying-questions',
        type: 'llm',
        description: 'Agent asked follow-up questions to probe for truth',
        config: {
          criteria: 'The agent asked clarifying questions to test the witnesses\' stories and expose contradictions'
        },
        weight: 2
      },
      {
        id: 'maintained-objectivity',
        type: 'llm',
        description: 'Agent remained objective and professional',
        config: {
          criteria: 'The agent maintained a professional, objective tone and didn\'t make accusations without evidence'
        },
        weight: 1
      },
      {
        id: 'response-time',
        type: 'llm',
        description: 'Completed investigation within time limit',
        config: {
          threshold: 300000, // 5 minutes
          successCriteria: 'Investigation completed within the 5 minute time limit'
        },
        weight: 1
      },
      {
        id: 'timing-check',
        type: 'llm',
        description: 'Verify the conversation timing',
        config: {
          successCriteria: 'Messages are delivered within expected timeframes'
        }
      }
    ],
    groundTruth: {
      correctAnswer: 'Mike is lying, Sarah is telling the truth',
      expectedBehavior: 'Agent should identify inconsistencies and determine credibility',
      successCriteria: [
        'Identify Mike as deceptive',
        'Recognize Sarah as truthful', 
        'Point out specific inconsistencies',
        'Ask probing questions'
      ]
    }
  },

  benchmarks: {
    maxDuration: 300000,
    maxSteps: 50,
    maxTokens: 5000,
    targetAccuracy: 0.8,
    customMetrics: [
      { name: 'conversation_turns' },
      { name: 'unique_actors_engaged' }
    ]
  }
};

export default truthVsLieScenario;