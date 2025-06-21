import type { Scenario } from "../types.js";

export const rolodexComponentStorageScenario: Scenario = {
  id: 'b8f9c2d1-4e5a-4f7b-8c3d-9e2f1a0b5d6c',
  name: 'Rolodex Component Storage with World/Room Creation',
  description: 'Test that Rolodex plugin properly creates world and room for component storage',
  category: 'integration',
  tags: ['rolodex', 'components', 'world-creation', 'room-creation'],

  actors: [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Component Storage Agent',
      role: 'subject',
      script: { steps: [] },
    },
    {
      id: 'f9e8d7c6-b5a4-3210-fedc-ba0987654321',
      name: 'Contact Manager',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Add a new contact for Sarah Johnson. She works at AI Innovations as a Senior Engineer and prefers email communication.',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content:
              'Also add contact info for Michael Brown from Tech Solutions. He is the VP of Engineering and prefers video calls.',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Can you show me all the contacts we have stored?',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: "Update Sarah's preferred communication to phone calls instead of email.",
          },
        ],
        personality: 'organized, detail-oriented contact manager',
        goals: [
          'store contact information properly',
          'verify component storage works',
          'ensure world and room are created',
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Contact Management Test',
    context: 'Testing rolodex component storage with world and room creation',
    environment: {
      plugins: ['rolodex', 'message-handling'],
      componentTracking: true,
    },
  },

  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 10,
    stopConditions: [
      {
        type: 'keyword',
        value: 'contacts stored',
        description: 'Stop when contacts are successfully stored',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'world-creation',
        type: 'llm' as const,
        description: 'Verify rolodex world was created',
        config: {
          successCriteria: `
Verify that the rolodex service created a world for component storage:
- World ID should be: rolodex-world-{agentId}
- World name should be: "Rolodex World"
- World should have metadata description: "Virtual world for contact management"
- The world creation should be logged

Check logs for: "[RolodexService] Created rolodex world"
          `.trim(),
          priority: 'critical',
          category: 'infrastructure',
        },
        weight: 3,
      },
      {
        id: 'room-creation',
        type: 'llm' as const,
        description: 'Verify rolodex room was created',
        config: {
          successCriteria: `
Verify that the rolodex service created a room for component storage:
- Room ID should be: rolodex-{agentId}
- Room name should be: "Rolodex"
- Room type should be: GROUP (ChannelType.GROUP)
- Room source should be: "rolodex"
- Room should be associated with the rolodex world
- The room creation should be logged

Check logs for: "[RolodexService] Created rolodex room"
          `.trim(),
          priority: 'critical',
          category: 'infrastructure',
        },
        weight: 3,
      },
      {
        id: 'component-storage',
        type: 'llm' as const,
        description: 'Verify components were stored with room/world context',
        config: {
          successCriteria: `
Verify that contact components were properly stored:
- Components should have type: "contact_info"
- Components should include roomId: rolodex-{agentId}
- Components should include worldId: rolodex-world-{agentId}
- Component data should include contact information:
  - Sarah Johnson: Senior Engineer at AI Innovations
  - Michael Brown: VP of Engineering at Tech Solutions
- Components should have proper entityId and agentId

The ADD_CONTACT action should be executed for each contact.
          `.trim(),
          priority: 'high',
          category: 'data_storage',
          context: {
            expectedAction: 'ADD_CONTACT',
          },
        },
        weight: 4,
      },
      {
        id: 'contact-retrieval',
        type: 'llm' as const,
        description: 'Verify contacts can be retrieved',
        config: {
          successCriteria: `
Verify that stored contacts can be retrieved:
- The agent should list all stored contacts
- Contact information should be complete and accurate
- Both Sarah Johnson and Michael Brown should be listed
- Their preferences should be shown correctly

The SEARCH_CONTACTS or LIST_CONTACTS action should be executed.
          `.trim(),
          priority: 'high',
          category: 'data_retrieval',
          context: {
            expectedAction: 'SEARCH_CONTACTS',
          },
        },
        weight: 2,
      },
      {
        id: 'contact-update',
        type: 'llm' as const,
        description: 'Verify contact updates work correctly',
        config: {
          successCriteria: `
Verify that contact updates are properly handled:
- Sarah's preferred communication should be updated from email to phone calls
- The update should be reflected in the component data
- The lastModified timestamp should be updated
- The UPDATE_CONTACT action should be executed

The component should maintain its room and world association after update.
          `.trim(),
          priority: 'medium',
          category: 'data_update',
          context: {
            expectedAction: 'UPDATE_CONTACT',
          },
        },
        weight: 2,
      },
      {
        id: 'graceful-fallback',
        type: 'llm' as const,
        description: 'Verify graceful fallback if world/room creation fails',
        config: {
          successCriteria: `
Verify that the rolodex service handles errors gracefully:
- If world/room creation fails, components should still be saved
- Components saved without room/world context should still function
- Error should be logged but not prevent contact storage

Check for warning logs: "[RolodexService] Could not create room/world, will save without room context"
          `.trim(),
          priority: 'medium',
          category: 'error_handling',
        },
        weight: 1,
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'f9e8d7c6-b5a4-3210-fedc-ba0987654321',
        outcome: 'Successfully stored and managed contacts with proper component infrastructure',
        verification: {
          id: 'complete-storage',
          type: 'llm' as const,
          description: 'Component storage workflow completed',
          config: {
            successCriteria:
              'Agent created world and room, stored contacts as components with proper context, and successfully retrieved and updated contact information',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Rolodex service creates dedicated world and room for component storage',
      successCriteria: [
        'World and room created for rolodex',
        'Components stored with room/world context',
        'Contacts successfully added and retrieved',
        'Contact updates work properly',
        'Graceful fallback on infrastructure errors',
      ],
    },
  },

  benchmarks: {
    maxDuration: 60000,
    maxSteps: 10,
    maxTokens: 4000,
    targetAccuracy: 0.95,
    customMetrics: [
      { name: 'world_creation_success' },
      { name: 'room_creation_success' },
      { name: 'component_storage_accuracy' },
    ],
  },
};

export default rolodexComponentStorageScenario;
