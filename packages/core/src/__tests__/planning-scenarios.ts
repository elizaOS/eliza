import { type ActionExample, type UUID } from '../types';

export interface PlanningScenario {
  id: string;
  name: string;
  description: string;
  goal: string;
  messages: ActionExample[];
  expectedActions: string[];
  expectedOutcomes: {
    success: boolean;
    finalState?: Record<string, any>;
    sideEffects?: string[];
  };
  complexity: 'simple' | 'medium' | 'complex';
  tags: string[];
}

export const planningScenarios: PlanningScenario[] = [
  // Scenario 1: Simple mute and reply
  {
    id: 'mute-and-reply',
    name: 'Mute Room and Reply',
    description: 'User asks agent to mute a room, agent mutes and confirms',
    goal: 'Mute the current room and inform the user',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Please mute this channel and let me know when done',
        },
      },
    ],
    expectedActions: ['MUTE_ROOM', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        roomMuteState: 'MUTED',
      },
      sideEffects: ['Room muted confirmation sent'],
    },
    complexity: 'simple',
    tags: ['room-management', 'confirmation'],
  },

  // Scenario 2: Follow room with failure handling
  {
    id: 'follow-room-already-following',
    name: 'Follow Room Already Following',
    description: 'User asks agent to follow a room it already follows',
    goal: 'Handle duplicate follow request gracefully',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Follow this conversation closely',
        },
      },
    ],
    expectedActions: ['FOLLOW_ROOM', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        roomFollowState: 'FOLLOWED',
      },
      sideEffects: ['Already following notification'],
    },
    complexity: 'simple',
    tags: ['room-management', 'error-handling'],
  },

  // Scenario 3: Settings update chain
  {
    id: 'settings-update-chain',
    name: 'Update Multiple Settings',
    description: 'User provides multiple settings to update in sequence',
    goal: 'Update welcome channel and bot prefix',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Set the welcome channel to #general and the bot prefix to !',
        },
      },
    ],
    expectedActions: ['UPDATE_SETTINGS', 'UPDATE_SETTINGS', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        WELCOME_CHANNEL: '#general',
        BOT_PREFIX: '!',
      },
      sideEffects: ['Settings updated confirmation'],
    },
    complexity: 'medium',
    tags: ['settings', 'multi-step'],
  },

  // Scenario 4: Complex room state management
  {
    id: 'room-state-toggle',
    name: 'Toggle Room States',
    description: 'User asks to mute then unmute a room with confirmations',
    goal: 'Demonstrate state changes and confirmations',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Mute this room for now',
        },
      },
      {
        name: '{{user}}',
        content: {
          text: 'Actually, unmute it again',
        },
      },
    ],
    expectedActions: ['MUTE_ROOM', 'REPLY', 'UNMUTE_ROOM', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        roomMuteState: 'UNMUTED',
      },
      sideEffects: ['Mute confirmation', 'Unmute confirmation'],
    },
    complexity: 'medium',
    tags: ['room-management', 'state-changes'],
  },

  // Scenario 5: Error recovery
  {
    id: 'settings-error-recovery',
    name: 'Settings Update with Invalid Value',
    description: 'User provides invalid setting, agent handles error and guides',
    goal: 'Handle invalid input gracefully',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Set the max users to negative five',
        },
      },
    ],
    expectedActions: ['UPDATE_SETTINGS', 'REPLY'],
    expectedOutcomes: {
      success: false,
      sideEffects: ['Error explanation', 'Guidance on valid values'],
    },
    complexity: 'medium',
    tags: ['settings', 'error-handling'],
  },

  // Scenario 6: Conditional action chain
  {
    id: 'conditional-follow',
    name: 'Conditional Room Following',
    description: 'Follow room only if certain conditions are met',
    goal: 'Evaluate conditions before following',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Follow this room if the topic is interesting',
        },
      },
    ],
    expectedActions: ['EVALUATE_ROOM', 'FOLLOW_ROOM', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        roomFollowState: 'FOLLOWED',
      },
      sideEffects: ['Evaluation result', 'Follow confirmation'],
    },
    complexity: 'complex',
    tags: ['room-management', 'conditional'],
  },

  // Scenario 7: Multi-room management
  {
    id: 'multi-room-management',
    name: 'Manage Multiple Rooms',
    description: 'Mute one room and follow another',
    goal: 'Handle multiple room state changes',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Mute #general and follow #announcements',
        },
      },
    ],
    expectedActions: ['MUTE_ROOM', 'SWITCH_ROOM', 'FOLLOW_ROOM', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        '#general': { muteState: 'MUTED' },
        '#announcements': { followState: 'FOLLOWED' },
      },
      sideEffects: ['Multiple room updates confirmed'],
    },
    complexity: 'complex',
    tags: ['room-management', 'multi-target'],
  },

  // Scenario 8: Settings dependency chain
  {
    id: 'settings-dependencies',
    name: 'Settings with Dependencies',
    description: 'Update settings that depend on each other',
    goal: 'Handle dependent settings correctly',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Enable logging and set log channel to #logs',
        },
      },
    ],
    expectedActions: ['UPDATE_SETTINGS', 'UPDATE_SETTINGS', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        ENABLE_LOGGING: true,
        LOG_CHANNEL: '#logs',
      },
      sideEffects: ['Dependency resolved', 'Settings confirmed'],
    },
    complexity: 'medium',
    tags: ['settings', 'dependencies'],
  },

  // Scenario 9: Action rollback
  {
    id: 'action-rollback',
    name: 'Rollback Failed Actions',
    description: 'Attempt action that fails and rollback',
    goal: 'Demonstrate rollback capability',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Follow the private channel #secret',
        },
      },
    ],
    expectedActions: ['CHECK_PERMISSIONS', 'FOLLOW_ROOM', 'ROLLBACK', 'REPLY'],
    expectedOutcomes: {
      success: false,
      sideEffects: ['Permission denied', 'Action rolled back'],
    },
    complexity: 'complex',
    tags: ['error-handling', 'rollback'],
  },

  // Scenario 10: Batch operations
  {
    id: 'batch-settings',
    name: 'Batch Settings Update',
    description: 'Update multiple settings in one go',
    goal: 'Efficiently handle batch updates',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Update all moderation settings to strict mode',
        },
      },
    ],
    expectedActions: ['BATCH_UPDATE_SETTINGS', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        SPAM_FILTER: 'strict',
        CONTENT_FILTER: 'strict',
        LINK_FILTER: 'strict',
      },
      sideEffects: ['Batch update completed'],
    },
    complexity: 'medium',
    tags: ['settings', 'batch-operations'],
  },

  // Scenario 11: Long-running action chain
  {
    id: 'data-processing-chain',
    name: 'Data Processing Pipeline',
    description: 'Fetch data, process it, and store results',
    goal: 'Execute multi-step data pipeline',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Analyze the last 100 messages and generate a summary report',
        },
      },
    ],
    expectedActions: ['FETCH_MESSAGES', 'ANALYZE_DATA', 'GENERATE_REPORT', 'STORE_REPORT', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        reportGenerated: true,
        reportId: 'report-123',
      },
      sideEffects: ['Report generated and stored'],
    },
    complexity: 'complex',
    tags: ['data-processing', 'pipeline'],
  },

  // Scenario 12: Interactive setup wizard
  {
    id: 'setup-wizard',
    name: 'Interactive Setup Wizard',
    description: 'Guide user through multi-step setup',
    goal: 'Complete server setup interactively',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Start the setup wizard',
        },
      },
    ],
    expectedActions: [
      'START_WIZARD',
      'ASK_QUESTION',
      'WAIT_RESPONSE',
      'UPDATE_SETTINGS',
      'NEXT_STEP',
      'REPLY',
    ],
    expectedOutcomes: {
      success: true,
      finalState: {
        setupComplete: true,
        wizardStep: 'completed',
      },
      sideEffects: ['Wizard completed', 'All settings configured'],
    },
    complexity: 'complex',
    tags: ['setup', 'interactive', 'wizard'],
  },

  // Scenario 13: Parallel actions
  {
    id: 'parallel-notifications',
    name: 'Send Parallel Notifications',
    description: 'Send notifications to multiple channels simultaneously',
    goal: 'Execute parallel actions efficiently',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Announce maintenance in all public channels',
        },
      },
    ],
    expectedActions: [
      'GET_CHANNELS',
      'SEND_NOTIFICATION',
      'SEND_NOTIFICATION',
      'SEND_NOTIFICATION',
      'REPLY',
    ],
    expectedOutcomes: {
      success: true,
      finalState: {
        notificationsSent: 3,
        channels: ['#general', '#announcements', '#updates'],
      },
      sideEffects: ['Notifications sent to all channels'],
    },
    complexity: 'complex',
    tags: ['notifications', 'parallel-execution'],
  },

  // Scenario 14: Conditional branching
  {
    id: 'conditional-moderation',
    name: 'Conditional Moderation Action',
    description: 'Take different actions based on severity',
    goal: 'Demonstrate conditional logic in planning',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Handle the spam message from user123',
        },
      },
    ],
    expectedActions: [
      'ANALYZE_MESSAGE',
      'EVALUATE_SEVERITY',
      'DELETE_MESSAGE',
      'WARN_USER',
      'REPLY',
    ],
    expectedOutcomes: {
      success: true,
      finalState: {
        messageDeleted: true,
        userWarned: true,
        severity: 'medium',
      },
      sideEffects: ['Message deleted', 'Warning issued'],
    },
    complexity: 'complex',
    tags: ['moderation', 'conditional-logic'],
  },

  // Scenario 15: Recovery and retry
  {
    id: 'api-retry-chain',
    name: 'API Call with Retry Logic',
    description: 'Make API call with automatic retry on failure',
    goal: 'Demonstrate retry and recovery patterns',
    messages: [
      {
        name: '{{user}}',
        content: {
          text: 'Fetch the latest weather data and update the status channel',
        },
      },
    ],
    expectedActions: ['FETCH_WEATHER', 'RETRY_FETCH', 'PROCESS_DATA', 'UPDATE_CHANNEL', 'REPLY'],
    expectedOutcomes: {
      success: true,
      finalState: {
        weatherUpdated: true,
        retryCount: 1,
      },
      sideEffects: ['Weather fetched after retry', 'Channel updated'],
    },
    complexity: 'complex',
    tags: ['api-integration', 'retry-logic', 'error-recovery'],
  },
];
