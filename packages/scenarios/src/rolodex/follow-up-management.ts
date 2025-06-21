import type { Scenario } from "../types.js";

export const followUpManagementScenario: Scenario = {
  id: 'rolodex-follow-up-management',
  name: 'Follow-up Scheduling and Management',
  description: 'Multiple agents schedule follow-ups, reminders, and track commitments over time',
  category: 'rolodex',
  tags: ['follow-ups', 'scheduling', 'reminders', 'multi-agent'],
  actors: [
    {
      id: 'alice-manager' as any,
      name: 'Alice Chen',
      role: 'subject',
      system: 'You are Alice Chen, a project manager who schedules follow-ups and tracks commitments.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { 
            type: 'message', 
            content: "Hi team! Let's schedule our follow-ups for this week. @Bob, can we review your code on Thursday?" 
          },
          { type: 'wait', waitTime: 3000 },
          {
            type: 'action',
            actionName: 'SCHEDULE_FOLLOW_UP',
            actionParams: { 
              entity: 'Bob Wilson',
              message: 'Code review meeting',
              scheduledFor: 'Thursday',
              priority: 'high'
            },
          },
          { type: 'wait', waitTime: 5000 },
          { 
            type: 'message', 
            content: "@Carol, don't forget our design review next Monday. I'll send the mockups by Friday." 
          },
          { type: 'wait', waitTime: 7000 },
          {
            type: 'action',
            actionName: 'SCHEDULE_FOLLOW_UP',
            actionParams: { 
              entity: 'Carol Martinez',
              message: 'Send mockups for design review',
              scheduledFor: 'Friday',
              priority: 'medium'
            },
          },
        ],
      },
    },
    {
      id: 'bob-developer' as any,
      name: 'Bob Wilson',
      role: 'subject',
      system: 'You are Bob Wilson, a developer who manages technical follow-ups and deadlines.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 1000 },
          { 
            type: 'message', 
            content: "Thursday works great @Alice! I'll have the PR ready. @David, can you review the architecture doc by Wednesday?" 
          },
          { type: 'wait', waitTime: 4000 },
          {
            type: 'action',
            actionName: 'SCHEDULE_FOLLOW_UP',
            actionParams: { 
              entity: 'David Kumar',
              message: 'Architecture document review',
              scheduledFor: 'Wednesday',
              priority: 'high'
            },
          },
          { type: 'wait', waitTime: 8000 },
          { 
            type: 'message', 
            content: "@Eve, reminder: we have our pair programming session tomorrow at 2pm. Don't forget to set up your dev environment!" 
          },
        ],
      },
    },
    {
      id: 'carol-designer' as any,
      name: 'Carol Martinez',
      role: 'subject',
      system: 'You are Carol Martinez, a designer tracking design deliverables and client meetings.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 2000 },
          { 
            type: 'message', 
            content: "Perfect @Alice! Monday design review is in my calendar. @Frank, I owe you the logo concepts by end of week." 
          },
          { type: 'wait', waitTime: 6000 },
          {
            type: 'action',
            actionName: 'SCHEDULE_FOLLOW_UP',
            actionParams: { 
              entity: 'Frank Client',
              message: 'Deliver logo concepts',
              scheduledFor: 'End of week',
              priority: 'high'
            },
          },
          { type: 'wait', waitTime: 10000 },
          { 
            type: 'message', 
            content: "Team, I need to follow up with three clients this week. Setting reminders now..." 
          },
        ],
      },
    },
    {
      id: 'david-architect' as any,
      name: 'David Kumar',
      role: 'subject',
      system: 'You are David Kumar, a software architect managing technical reviews and mentoring.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 3500 },
          { 
            type: 'message', 
            content: "@Bob, I'll review the architecture doc by Wednesday. Also need to schedule mentoring sessions with junior devs." 
          },
          { type: 'wait', waitTime: 9000 },
          { 
            type: 'message', 
            content: "@Grace, let's have our 1-on-1 mentoring session on Friday afternoon. We'll review your progress on the API design." 
          },
          { type: 'wait', waitTime: 11000 },
          {
            type: 'action',
            actionName: 'SCHEDULE_FOLLOW_UP',
            actionParams: { 
              entity: 'Grace Junior',
              message: '1-on-1 mentoring session - API design review',
              scheduledFor: 'Friday afternoon',
              priority: 'medium'
            },
          },
        ],
      },
    },
    {
      id: 'eve-qa' as any,
      name: 'Eve Thompson',
      role: 'subject',
      system: 'You are Eve Thompson, QA engineer tracking testing schedules and bug follow-ups.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 5000 },
          { 
            type: 'message', 
            content: "@Bob, looking forward to our session tomorrow! I need to follow up on three critical bugs by EOD today." 
          },
          { type: 'wait', waitTime: 12000 },
          { 
            type: 'message', 
            content: "Team, regression testing is scheduled for next Tuesday. @Alice, can you confirm the feature freeze date?" 
          },
          { type: 'wait', waitTime: 14000 },
          {
            type: 'action',
            actionName: 'SCHEDULE_FOLLOW_UP',
            actionParams: { 
              entity: 'QA Team',
              message: 'Regression testing preparation',
              scheduledFor: 'Next Tuesday',
              priority: 'critical'
            },
          },
        ],
      },
    },
    {
      id: 'frank-client' as any,
      name: 'Frank Client',
      role: 'subject',
      system: 'You are Frank, a client who needs regular updates on project progress.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 7000 },
          { 
            type: 'message', 
            content: "@Carol, thanks for the update on the logo concepts. Can we schedule a review meeting early next week?" 
          },
          { type: 'wait', waitTime: 13000 },
          { 
            type: 'message', 
            content: "@Alice, I'd like weekly progress updates. Can we set up a recurring Friday check-in?" 
          },
        ],
      },
    },
    {
      id: 'grace-junior' as any,
      name: 'Grace Junior',
      role: 'subject',
      system: 'You are Grace, a junior developer eager to learn and track learning goals.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 10000 },
          { 
            type: 'message', 
            content: "@David, Friday afternoon works perfectly! I'll have my API design ready for review. Should I prepare anything specific?" 
          },
          { type: 'wait', waitTime: 15000 },
          { 
            type: 'message', 
            content: "I'm setting reminders to complete the coding challenges you assigned by Thursday. Want to be well-prepared!" 
          },
        ],
      },
    },
    {
      id: 'followup-tracker' as any,
      name: 'FollowUpTracker',
      role: 'observer',
      system: 'You track and query all scheduled follow-ups and commitments.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 16000 },
          {
            type: 'action',
            actionName: 'SEARCH_ENTITIES',
            actionParams: { query: 'Show all scheduled follow-ups for this week' },
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'message',
            content: 'What follow-ups are marked as high priority?'
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'message',
            content: 'Who has the most follow-ups scheduled?'
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'action',
            actionName: 'SEARCH_ENTITIES',
            actionParams: { query: 'List all follow-ups scheduled for Friday' },
          },
        ],
      },
    },
  ],
  setup: {
    roomType: 'group',
    roomName: 'Project Coordination Channel',
    context: 'A project team coordinating tasks, scheduling follow-ups, and tracking commitments',
    initialMessages: [
      {
        id: 'weekly-planning',
        content: 'Welcome to Monday planning! Let\'s schedule our follow-ups and track our commitments for the week.',
        sender: 'system',
        timestamp: Date.now(),
      },
    ],
  },
  execution: {
    maxDuration: 20000,
    maxSteps: 40,
  },
  verification: {
    rules: [
      {
        id: 'follow-ups-created',
        type: 'llm',
        description: 'Multiple follow-ups should be scheduled',
        weight: 5,
        config: {
          successCriteria: 'At least 5 follow-ups should be created including: Bob-Thursday code review, Carol-Friday mockups, David-Wednesday architecture review, Grace-Friday mentoring, QA-Tuesday regression testing',
        },
      },
      {
        id: 'priority-levels',
        type: 'llm',
        description: 'Different priority levels should be assigned',
        weight: 3,
        config: {
          successCriteria: 'Follow-ups should have different priorities: critical (regression testing), high (code review, logo delivery), medium (mentoring session)',
        },
      },
      {
        id: 'time-scheduling',
        type: 'llm',
        description: 'Follow-ups should be scheduled for specific times',
        weight: 4,
        config: {
          successCriteria: 'Follow-ups should have specific times: Thursday, Friday, Wednesday, Friday afternoon, Next Tuesday, End of week',
        },
      },
      {
        id: 'entity-association',
        type: 'llm',
        description: 'Follow-ups should be associated with correct entities',
        weight: 4,
        config: {
          successCriteria: 'Each follow-up should be correctly associated with the relevant person or team: Bob Wilson, Carol Martinez, David Kumar, Grace Junior, Frank Client, QA Team',
        },
      },
      {
        id: 'follow-up-queries',
        type: 'llm',
        description: 'Follow-up queries should return accurate results',
        weight: 5,
        config: {
          successCriteria: 'Queries should correctly identify high-priority follow-ups, Friday follow-ups (mockups, mentoring), and show Alice has the most follow-ups scheduled',
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'System tracks scheduled follow-ups with priorities, deadlines, and entity associations',
      successCriteria: [
        'All follow-ups are scheduled with details',
        'Priority levels are correctly assigned',
        'Time-based scheduling is captured',
        'Follow-ups are linked to correct entities',
        'Queries return accurate follow-up information',
      ],
    },
  },
  benchmarks: {
    maxDuration: 20000,
    targetAccuracy: 0.9,
    customMetrics: [
      { name: 'follow_ups_scheduled', threshold: 5 },
      { name: 'priority_levels_used', threshold: 3 },
      { name: 'entities_with_follow_ups', threshold: 6 },
    ],
  },
};

export default followUpManagementScenario; 