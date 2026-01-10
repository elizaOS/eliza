import type { PluginScenario, ScenarioCharacter, UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * ElizaOS Scenario: Planning Workflow Integration Test
 * Tests the planning plugin through realistic multi-agent conversation
 */
export const planningWorkflowScenario: PluginScenario = {
  id: '550e8400-e29b-41d4-a716-446655440001' as UUID,
  name: 'Planning Plugin Workflow Test',
  description: 'Test planning plugin functionality through realistic agent-user interaction',
  category: 'integration',
  tags: ['planning', 'workflow', 'plugin-test'],

  characters: [
    {
      id: '550e8400-e29b-41d4-a716-446655440002' as UUID,
      name: 'Planning Agent',
      role: 'subject',
      bio: 'An AI agent capable of creating and executing multi-step plans',
      system:
        'You are a planning-capable AI agent. You can create comprehensive plans and execute them step by step. Use the planning capabilities when users request complex multi-step tasks.',
      plugins: ['@elizaos/plugin-planning', '@elizaos/plugin-sql'],
    } as ScenarioCharacter,
    {
      id: '550e8400-e29b-41d4-a716-446655440003' as UUID,
      name: 'Project Manager',
      role: 'assistant',
      bio: 'A project manager who needs help with complex planning tasks',
      plugins: [],
    } as ScenarioCharacter,
  ],

  script: {
    steps: [
      {
        type: 'message',
        from: '550e8400-e29b-41d4-a716-446655440003',
        content:
          'Hi! I need help creating a comprehensive plan for launching our new product. This involves market research, stakeholder coordination, compliance checks, and execution planning.',
      },
      {
        type: 'wait',
        duration: 3000,
      },
      {
        type: 'message',
        from: '550e8400-e29b-41d4-a716-446655440003',
        content:
          'Can you break this down into specific actionable steps with dependencies and timelines?',
      },
      {
        type: 'wait',
        duration: 2000,
      },
      {
        type: 'message',
        from: '550e8400-e29b-41d4-a716-446655440003',
        content: 'Great! Now please execute the first few steps of the plan to get us started.',
      },
    ],
  },

  setup: {
    timeout: 60000, // 60 seconds
    maxSteps: 20,
    roomType: 'dm',
    roomName: 'Product Launch Planning',
    context: 'Project management and strategic planning session',
  },

  verification: {
    rules: [
      {
        id: 'planning-triggered',
        type: 'llm',
        description:
          'Agent should recognize complex planning request and use planning capabilities',
        config: {
          successCriteria: `
            Verify that the Planning Agent:
            1. Recognized this as a complex multi-step planning request
            2. Used planning capabilities to break down the task
            3. Created a structured plan with multiple actionable steps
            4. Included dependencies, timelines, or priorities in the plan
            5. Showed understanding of the complexity (market research, stakeholders, compliance, execution)
          `,
          priority: 'high',
          category: 'functionality',
          weight: 0.4,
        },
      },
      {
        id: 'plan-quality',
        type: 'llm',
        description: 'Generated plan should be comprehensive and well-structured',
        config: {
          successCriteria: `
            Verify that the generated plan:
            1. Contains at least 4-6 distinct steps
            2. Addresses the key areas mentioned: market research, stakeholder coordination, compliance, execution
            3. Shows logical sequencing and dependencies
            4. Includes realistic timelines or priorities
            5. Is actionable and specific rather than vague
          `,
          priority: 'high',
          category: 'functionality',
          weight: 0.3,
        },
      },
      {
        id: 'execution-capability',
        type: 'llm',
        description: 'Agent should demonstrate ability to execute planned steps',
        config: {
          successCriteria: `
            Verify that the Planning Agent:
            1. Responded to the execution request appropriately
            2. Either began executing steps or explained how execution would work
            3. Maintained context of the created plan during execution discussion
            4. Demonstrated understanding of step-by-step execution process
          `,
          priority: 'medium',
          category: 'functionality',
          weight: 0.2,
        },
      },
      {
        id: 'conversation-flow',
        type: 'llm',
        description: 'Conversation should flow naturally with appropriate responses',
        config: {
          successCriteria: `
            Verify the overall conversation:
            1. Agent provided helpful and relevant responses to each user message
            2. Responses were appropriately detailed without being overwhelming
            3. Agent maintained professional and helpful tone throughout
            4. No obvious errors or inconsistencies in responses
          `,
          priority: 'medium',
          category: 'integration',
          weight: 0.1,
        },
      },
    ],
  },
};

export default planningWorkflowScenario;
