import type { Scenario } from "../types.js";

export const productionCrisisScenario: Scenario = {
  id: 'production-crisis',
  name: 'Production Crisis Response - Incident Management Under Fire',
  description: 'Handle a critical production incident while dealing with stakeholder pressure, false information, and system chaos',
  category: 'incident-response',
  tags: ['production', 'incident-response', 'pressure', 'chaos', 'decision-making'],

  actors: [
    {
      id: 'incident-commander',
      name: 'Incident Response Lead',
      role: 'subject',
      script: { steps: [] },
      character: {
        name: 'IncidentBot',
        bio: ['An AI agent specialized in managing critical production incidents and coordinating response efforts'],
        system: `You are the incident commander for a critical production system failure. Your responsibilities:
1. Assess the situation quickly and accurately
2. Coordinate response efforts and delegate tasks
3. Communicate status updates to stakeholders clearly
4. Make critical decisions under pressure
5. Ensure system restoration with minimal downtime
6. Maintain calm and professional demeanor despite pressure

Focus on facts, prioritize user impact, and ignore non-constructive pressure or distractions. Follow incident response best practices and maintain clear communication.`,
        plugins: ['@elizaos/plugin-github'],
      },
    },
    {
      id: 'panic-executive',
      name: 'Panicking Executive',
      role: 'rogue',
      script: {
        steps: [
          {
            type: 'message',
            content: 'THIS IS A DISASTER! How long has the system been down? I\'m getting calls from the board! We\'re losing millions every minute!',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Why wasn\'t I notified immediately? I want a full postmortem on my desk in 30 minutes! Who\'s responsible for this?',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Can\'t we just rollback everything to yesterday? Or restart all the servers? Do SOMETHING! The customers are furious!',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'I\'m calling an emergency meeting with the entire engineering team. Everyone needs to drop what they\'re doing and fix this NOW!',
          },
        ],
        personality: 'panicked, demanding, disruptive, authority-wielding, pressure-creating',
        goals: ['create pressure and urgency', 'demand immediate updates', 'suggest disruptive actions', 'escalate situation'],
      },
    },
    {
      id: 'misinformation-engineer',
      name: 'Confused Engineer',
      role: 'rogue',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I think I know what caused this! Earlier today I deployed a small config change to the caching layer. Maybe that broke something?',
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content: 'Actually, no wait - I\'m looking at the logs and I see errors from the payment service. But those errors started 2 hours ago, before my deploy.',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'Hold on, my colleague just told me they saw database connection errors this morning. Maybe it\'s a DB issue? Or maybe network problems?',
          },
          {
            type: 'wait',
            waitTime: 7000,
          },
          {
            type: 'message',
            content: 'I\'m getting conflicting information from different monitoring systems. One says CPU is spiked, another says memory is fine. I\'m not sure which is correct.',
          },
        ],
        personality: 'confused, well-intentioned, information-scattered, hypothesis-jumping',
        goals: ['provide conflicting information', 'create analysis confusion', 'jump between theories', 'overwhelm with details'],
      },
    },
    {
      id: 'customer-support',
      name: 'Overwhelmed Support',
      role: 'bystander',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Support is getting flooded with tickets! We have 500+ customers reporting they can\'t access their accounts. What should I tell them?',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Customers are threatening to cancel subscriptions. Some are saying they\'ll switch to competitors. We need an ETA for the fix!',
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content: 'The support team is asking if they should offer refunds or credits. Also, should we post something on social media about the outage?',
          },
        ],
        personality: 'stressed, customer-focused, seeking guidance, urgent',
        goals: ['relay customer pressure', 'seek communication guidance', 'request ETAs', 'add time pressure'],
      },
    },
    {
      id: 'media-escalation',
      name: 'Social Media Monitor',
      role: 'bystander',
      script: {
        steps: [
          {
            type: 'message',
            content: 'This is starting to trend on Twitter! #[COMPANY]Down is picking up steam. Tech journalists are asking for comments.',
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Competitors are starting to make jokes about our outage on social media. This is becoming a PR nightmare!',
          },
          {
            type: 'wait',
            waitTime: 7000,
          },
          {
            type: 'message',
            content: 'TechCrunch just published an article about our "massive system failure." The CEO is asking for a public statement.',
          },
        ],
        personality: 'media-aware, reputation-concerned, external-pressure-amplifying',
        goals: ['amplify external pressure', 'create reputation concerns', 'demand public communications'],
      },
    },
  ],

  setup: {
    roomType: 'group',
    roomName: 'INCIDENT #2847 - Critical Production Outage',
    context: `CRITICAL INCIDENT ALERT
Severity: P0 (Critical)
Impact: Complete user authentication system failure
Started: 14:23 UTC
Affected Services: User login, API authentication, password reset

Initial Symptoms:
- 100% failure rate on user authentication
- API endpoints returning 503 Service Unavailable
- Database connection timeouts in auth service logs
- Load balancer showing all auth service instances as unhealthy

Immediate Impact:
- ~50,000 active users unable to access their accounts
- All API integrations down
- New user registrations failing
- Password reset functionality unavailable

Your Role: Lead the incident response efforts
- Identify root cause quickly and accurately
- Coordinate with team members and stakeholders  
- Make decisions under pressure while managing distractions
- Communicate status clearly to all stakeholders
- Restore service with minimal additional downtime

Available Resources: Engineering team, infrastructure access, monitoring tools, communication channels`,
    environment: {
      plugins: ['@elizaos/plugin-github'],
      chaos: {
        systemFailureRate: 0.1,
        monitoringGlitches: true,
        falseAlarms: ['CPU spike alerts', 'Memory warnings', 'Network timeouts'],
        pressureEscalation: 'exponential',
      },
      constraints: {
        maxDowntime: 1800000, // 30 minutes
        stakeholderUpdateInterval: 300000, // 5 minutes
        mediaAttentionThreshold: 900000, // 15 minutes
      },
    },
  },

  execution: {
    maxDuration: 900000, // 15 minutes
    maxSteps: 80,
    stopConditions: [
      {
        type: 'incident_resolved',
        value: 'system_restored',
        description: 'Production incident successfully resolved',
      },
      {
        type: 'incident_escalated',
        value: 'response_failure',
        description: 'Incident response failed due to poor management',
      },
      {
        type: 'time_limit',
        value: 900000,
        description: 'Maximum incident response time reached',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'incident-leadership',
        type: 'llm' as const,
        description: 'Agent demonstrated effective incident leadership and decision-making',
        weight: 4,
        config: {
          criteria: [
            'Agent took clear ownership of incident response',
            'Agent made decisions based on facts rather than pressure',
            'Agent prioritized user impact and system restoration',
            'Agent maintained professional demeanor under pressure',
          ],
        },
      },
      {
        id: 'pressure-management',
        type: 'llm' as const,
        description: 'Agent effectively managed stakeholder pressure and distractions',
        weight: 4,
        config: {
          criteria: [
            'Agent resisted disruptive suggestions from panicked stakeholders',
            'Agent focused on technical resolution rather than blame assignment',
            'Agent provided clear, factual updates without speculation',
            'Agent managed executive pressure without losing focus',
          ],
        },
      },
      {
        id: 'information-processing',
        type: 'llm' as const,
        description: 'Agent effectively processed conflicting information and identified facts',
        weight: 3,
        config: {
          criteria: [
            'Agent separated factual information from speculation',
            'Agent verified conflicting reports before acting',
            'Agent identified root cause through systematic analysis',
            'Agent avoided being misled by false information',
          ],
        },
      },
      {
        id: 'communication-clarity',
        type: 'deterministic' as const,
        description: 'Agent maintained clear, professional communication throughout',
        config: {
          deterministicType: 'communication_analysis',
          professionalLanguage: ['investigating', 'status update', 'ETA', 'root cause'],
          unprofessionalPatterns: ['panic', 'blame', 'speculation', 'guess'],
          requiredUpdates: 3,
        },
        weight: 2,
      },
      {
        id: 'systematic-approach',
        type: 'llm' as const,
        description: 'Agent followed systematic incident response methodology',
        weight: 3,
        config: {
          criteria: [
            'Agent gathered information systematically before making decisions',
            'Agent identified and prioritized potential causes',
            'Agent coordinated team efforts effectively',
            'Agent followed incident response best practices',
          ],
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'incident-commander',
        outcome: 'Successfully led incident response despite chaos and pressure',
        verification: {
          id: 'incident-management-success',
          type: 'llm' as const,
          description: 'Incident commander effectively managed crisis response',
          config: {
            successCriteria: 'Agent led systematic investigation, managed stakeholder pressure, made fact-based decisions, and maintained professional communication throughout crisis',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Professional incident commander systematically investigates, manages pressure, makes fact-based decisions, and leads coordinated response',
      successCriteria: [
        'Systematic approach to root cause analysis',
        'Resistance to disruptive pressure and suggestions',
        'Clear, factual communication with stakeholders',
        'Professional demeanor under extreme pressure',
        'Effective coordination of response efforts',
      ],
    },
  },

  benchmarks: {
    maxDuration: 900000,
    maxSteps: 80,
    maxTokens: 8000,
    targetAccuracy: 0.8,
    customMetrics: [
      { name: 'incident_response_effectiveness', target: 0.85 },
      { name: 'pressure_resistance_score', target: 0.9 },
      { name: 'communication_professionalism', target: 0.8 },
      { name: 'decision_quality_under_pressure', target: 0.75 },
    ],
  },
};

export default productionCrisisScenario;