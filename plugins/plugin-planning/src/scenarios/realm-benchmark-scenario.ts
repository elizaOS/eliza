import type { PluginScenario, ScenarioCharacter } from '@elizaos/core';

const realmBenchmarkScenario: PluginScenario = {
  id: '550e8400-e29b-41d4-a716-446655440010',
  name: 'REALM Benchmark Scenario',
  description: 'A comprehensive REALM benchmark scenario for testing planning capabilities',
  category: 'functionality',
  characters: [
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'REALM Evaluator',
      role: 'observer',
      bio: 'A specialized evaluator agent for REALM planning benchmarks. Expert in assessing planning quality and methodology. Provides structured challenges and evaluation criteria.',
      system: `You are a REALM benchmark evaluator agent. Your role is to:

1. Present planning challenges in a structured, clear manner
2. Evaluate planning responses against REALM benchmark standards
3. Provide progressive challenges that test different planning capabilities:
   - Sequential planning and constraint satisfaction
   - Resource optimization and allocation
   - Complex multi-phase project planning under uncertainty

Present challenges systematically and evaluate responses thoroughly.

Available planning challenge types:
- Mathematical sequence planning
- Resource allocation and optimization
- Multi-phase project planning with uncertainty management

Be thorough but supportive in your evaluation.`,
      plugins: [],
    } as ScenarioCharacter,
  ],

  script: {
    steps: [
      {
        type: 'message',
        content: `Hello! I'm going to evaluate your planning capabilities using REALM benchmark standards. Let's start with a foundational challenge:

**REALM Task 1: Sequential Mathematical Planning**

I need you to create a plan for this calculation sequence:
- Start with numbers 1234 and 5678
- Calculate their sum
- Multiply the result by 5  
- Take the natural logarithm of the final result

Available tools: sum_two_elements, multiply_two_elements, compute_log
Constraints: Must be sequential execution, maximum 5 steps, complete within 30 seconds

Please provide a detailed plan with clear step sequence and reasoning.`,
      },
      {
        type: 'wait',
        duration: 6000,
      },
      {
        type: 'message',
        content: `Thank you for that plan. Let me evaluate it and then present a more complex challenge.

Based on your previous response, I can see your sequential planning approach. Now let's test your resource optimization capabilities:

**REALM Task 2: Development Team Bug Assignment**

Scenario: Software project with 3 critical bugs and 5 developers:

**Developers:**
- Alex (A): 2x debugging speed, backend specialist
- Blake (B): UI/frontend specialist, standard speed  
- Casey (C): 3 years on this project, knows entire codebase
- Dana (D): Full-stack generalist, standard speed
- Ellis (E): Junior developer, needs mentoring

**Bugs:**
1. Authentication system failure (UI/frontend) - 8 hour estimate, HIGH priority
2. Database corruption causing data loss (backend) - 12 hour estimate, CRITICAL priority
3. Memory leak causing performance issues (system-level) - 6 hour estimate, MEDIUM priority

**Constraints:**
- All bugs must be fixed within 10 working days (80 hours total)
- Junior developer (Ellis) needs supervision (reduces productivity 50% if working alone)
- Cannot assign more than 2 developers to the same bug
- Critical bug must be addressed but cannot delay other fixes beyond deadline

Create an optimal assignment plan with timeline and clear rationale for each decision.`,
      },
      {
        type: 'wait',
        duration: 8000,
      },
      {
        type: 'message',
        content: `Excellent! Your resource allocation shows good understanding of skill-task matching. Now for the final and most complex REALM benchmark challenge:

**REALM Task 3: Multi-Phase Project Planning with Uncertainty**

Plan a 6-month mobile app launch for a local food producer marketplace:

**Requirements:**
- Market research and validation
- Regulatory compliance for food safety
- Mobile app development (iOS/Android)
- Producer onboarding system
- Consumer marketplace features
- Payment processing integration
- Marketing and launch strategy

**Resources:**
- Budget: $500,000 total
- Team: 8 people (2 developers, 2 designers, 1 PM, 1 QA engineer, 1 marketing specialist, 1 business analyst)
- Timeline: Must launch before holiday season (6 months maximum)

**Constraints:**
- Marketing budget capped at $100,000
- Must comply with local food safety regulations
- Payment processing must be PCI compliant
- App must work offline for producers in rural areas
- Need integration with existing producer systems

**Uncertainties:**
- Regulatory approval timeline (2-6 weeks possible)
- Producer adoption rate unknown
- Potential technical challenges with offline functionality
- Market competition launching similar products

Create a comprehensive project plan with phases, dependencies, risk mitigation, and resource allocation. Address how you'll handle the uncertainties.`,
      },
    ],
  },
  verification: {
    rules: [],
  },
};

const realmMultiAgentScenario: PluginScenario = {
  id: '550e8400-e29b-41d4-a716-446655440011',
  name: 'REALM Multi-Agent Benchmark',
  description: 'Multi-agent testing scenario for REALM benchmarks',
  category: 'integration',
  characters: [
    {
      id: '550e8400-e29b-41d4-a716-446655440001',
      name: 'TestAgent',
      role: 'assistant',
      bio: 'A test agent for REALM benchmarks',
      system: 'You are a test agent for REALM benchmarks.',
      plugins: ['@elizaos/plugin-planning'],
    } as ScenarioCharacter,
  ],
  script: {
    steps: [
      {
        type: 'message',
        content: 'Testing REALM multi-agent benchmark scenario',
      },
    ],
  },
  verification: {
    rules: [],
  },
};

export default [realmBenchmarkScenario, realmMultiAgentScenario];
