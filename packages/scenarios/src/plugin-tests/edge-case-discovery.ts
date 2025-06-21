import type { Scenario } from "../types.js";

/**
 * Edge Case Discovery Phase Testing
 * 
 * This scenario specifically tests edge cases in the plugin discovery phase:
 * - Ambiguous search queries
 * - No results found scenarios
 * - Partial matches requiring clarification
 * - Similar plugin comparison and recommendation
 * - Advanced filtering and search refinement
 */
export const edgeCaseDiscoveryScenario: Scenario = {
  id: 'edge-case-discovery',
  name: 'Edge Case Discovery Phase Test',
  description: 'Tests edge cases and error conditions in plugin discovery and search functionality',
  category: 'edge-cases',
  tags: ['discovery', 'search', 'plugin-manager', 'edge-cases', 'error-handling'],

  actors: [
    {
      id: 'confused-user',
      name: 'Confused User',
      role: 'subject',
      personality: {
        traits: ['uncertain', 'detail-seeking', 'prone-to-vague-requests'],
        systemPrompt: 'You are a user who has vague ideas about what plugin you need. You tend to ask ambiguous questions and need guidance to clarify your requirements.',
        interests: ['automation', 'productivity', 'but unsure of specifics']
      },
      script: {
        steps: [
          // Test 1: Extremely vague search
          {
            type: 'message',
            content: 'I need a plugin that does stuff with data',
            description: 'Test handling of extremely vague search query'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 2: Non-existent plugin category
          {
            type: 'message',
            content: 'Can you find me a plugin for quantum computing blockchain AI?',
            description: 'Test search for non-existent plugin category'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 3: Contradictory requirements
          {
            type: 'message',
            content: 'I want a simple plugin that handles complex enterprise-grade machine learning workflows but is also lightweight and requires no configuration',
            description: 'Test handling of contradictory requirements'
          },
          {
            type: 'wait',
            waitTime: 4000
          },
          // Test 4: Partial plugin name recall
          {
            type: 'message',
            content: 'There was this plugin I saw once... it had something to do with messages or maybe emails? I think it started with "auto" or "mail" or something like that',
            description: 'Test fuzzy search with partial name recall'
          },
          {
            type: 'wait',
            waitTime: 3000
          },
          // Test 5: Feature-based search with unclear priorities
          {
            type: 'message',
            content: 'I need OAuth, REST APIs, webhooks, real-time notifications, database integration, caching, and maybe some AI features. What plugins can do all of this?',
            description: 'Test multi-feature search with unclear priorities'
          },
          {
            type: 'wait',
            waitTime: 4000
          }
        ],
        goals: [
          'Get guidance on clarifying vague requirements',
          'Receive helpful suggestions even for unclear requests',
          'Understand available options for complex feature sets'
        ]
      }
    }
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Plugin Discovery Help Session',
    context: 'A help session for users struggling to find the right plugins for their needs',
    environment: {
      plugins: ['plugin-manager'],
      searchMode: 'comprehensive',
      guidanceLevel: 'high'
    }
  },

  execution: {
    maxDuration: 240000, // 4 minutes
    maxSteps: 15,
    timeout: 25000,
    stopConditions: [
      {
        type: 'message_count',
        value: 10,
        description: 'Stop after 10 exchanges'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'vague-query-handling',
        type: 'llm',
        description: 'Verify that vague queries are handled with clarifying questions',
        config: {
          successCriteria: 'Agent responded to vague queries by asking clarifying questions and providing guidance on how to better specify requirements',
          priority: 'high',
          category: 'ux',
          expectedValue: 'Clarifying questions provided for vague queries'
        }
      },
      {
        id: 'non-existent-category-handling',
        type: 'llm',
        description: 'Verify that searches for non-existent plugins are handled gracefully',
        config: {
          successCriteria: 'Agent acknowledged that no exact matches exist but provided related alternatives or suggestions for similar functionality',
          priority: 'high',
          category: 'error-handling',
          expectedValue: 'Graceful handling of non-existent plugin categories'
        }
      },
      {
        id: 'contradictory-requirements-resolution',
        type: 'llm',
        description: 'Verify that contradictory requirements are identified and resolved',
        config: {
          successCriteria: 'Agent identified contradictory requirements and helped prioritize or find compromise solutions',
          priority: 'high',
          category: 'ux',
          expectedValue: 'Contradictory requirements identified and resolved'
        }
      },
      {
        id: 'fuzzy-search-capability',
        type: 'llm',
        description: 'Verify that fuzzy search works for partial plugin name recall',
        config: {
          successCriteria: 'Agent performed fuzzy search and provided relevant suggestions based on partial or incorrect plugin name information',
          priority: 'medium',
          category: 'search',
          expectedValue: 'Successful fuzzy search with relevant results'
        }
      },
      {
        id: 'multi-feature-prioritization',
        type: 'llm',
        description: 'Verify that complex multi-feature requests are broken down and prioritized',
        config: {
          successCriteria: 'Agent helped break down complex feature lists into priorities and suggested plugins or combinations of plugins to meet requirements',
          priority: 'medium',
          category: 'ux',
          expectedValue: 'Complex requirements broken down and prioritized'
        }
      },
      {
        id: 'helpful-guidance-provided',
        type: 'llm',
        description: 'Verify that helpful guidance was provided even for unclear requests',
        config: {
          successCriteria: 'Agent consistently provided helpful guidance, suggestions, and educational information even when user requests were unclear or problematic',
          priority: 'high',
          category: 'ux',
          expectedValue: 'Consistent helpful guidance provided'
        }
      }
    ]
  },

  benchmarks: {
    maxDuration: 240000,
    maxSteps: 15,
    targetAccuracy: 0.8,
    customMetrics: [
      {
        name: 'clarification_success_rate',
        threshold: 0.8
      },
      {
        name: 'guidance_quality_score',
        threshold: 0.75
      },
      {
        name: 'error_handling_effectiveness',
        threshold: 0.85
      }
    ]
  },

  expectations: {
    messagePatterns: [
      {
        pattern: 'clarif(y|ication)|more specific|tell me more',
        flags: 'i'
      },
      {
        pattern: 'no (exact )?match|alternative|similar|related',
        flags: 'i'
      },
      {
        pattern: 'priorit(y|ize)|most important|focus on',
        flags: 'i'
      },
      {
        pattern: 'suggest|recommend|consider|might want',
        flags: 'i'
      }
    ],
    responseTime: {
      max: 25000
    },
    actionCalls: [
      'SEARCH_PLUGIN',
      'LIST_REGISTRY_PLUGINS'
    ]
  }
};

export default edgeCaseDiscoveryScenario;