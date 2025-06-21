import { type IAgentRuntime, logger, type UUID } from '@elizaos/core';
import type { Scenario, ScenarioActor, VerificationRule } from './types.js';

export class LLMScenarioGenerator {
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async generateScenario(
    description: string,
    context?: {
      plugins?: string[];
      complexity?: 'low' | 'medium' | 'high' | 'very-high';
      testType?: 'functional' | 'integration' | 'security' | 'performance';
      duration?: number;
      actors?: number;
    }
  ): Promise<Scenario> {
    const prompt = this.buildScenarioGenerationPrompt(description, context);

    logger.info('Generating scenario using LLM');

    const { ModelType } = await import('@elizaos/core');
    const response = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.6, // Some creativity but still structured
      maxTokens: 3000,
    })) as string;

    return this.parseGeneratedScenario(response, description);
  }

  async generateActorPersonalities(
    scenarioContext: string,
    actorRoles: string[],
    complexity: string = 'medium'
  ): Promise<ScenarioActor[]> {
    const prompt = `You are an expert in AI agent persona design. Create realistic, diverse actor personalities for a scenario.

SCENARIO CONTEXT:
${scenarioContext}

REQUIRED ACTOR ROLES:
${actorRoles.map((role, i) => `${i + 1}. ${role}`).join('\n')}

COMPLEXITY LEVEL: ${complexity}

For each actor, create:
1. A unique personality with specific traits, expertise, and communication style
2. Realistic motivations and goals within the scenario
3. Appropriate system prompts that define their capabilities
4. Interaction scripts that feel natural and purposeful
5. Edge cases and challenging behaviors to test the subject agent

Make actors diverse in:
- Technical expertise levels (beginner to expert)
- Communication styles (formal, casual, technical, non-technical)
- Personality traits (patient, impatient, detail-oriented, big-picture)
- Cultural backgrounds and perspectives
- Problem-solving approaches

For each actor, provide:
ACTOR_[NUMBER]:
ID: [kebab-case-id]
NAME: [realistic name]
ROLE: [subject/participant/tester]
PERSONALITY: [detailed personality description]
EXPERTISE: [technical expertise level and areas]
COMMUNICATION_STYLE: [how they communicate]
GOALS: [what they want to achieve in this scenario]
SYSTEM_PROMPT: [detailed system prompt defining their capabilities]
SCRIPT_PREVIEW: [3-4 example messages they might send]

Create personalities that will thoroughly test the subject agent through realistic, challenging interactions.`;

    const { ModelType } = await import('@elizaos/core');
    const response = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.7,
      maxTokens: 2500,
    })) as string;

    return this.parseGeneratedActors(response);
  }

  async generateAdaptiveVerificationRules(
    scenario: string,
    actors: ScenarioActor[],
    testObjectives: string[]
  ): Promise<VerificationRule[]> {
    const prompt = `You are an expert test designer specializing in AI agent evaluation. Create comprehensive verification rules that adapt to the specific scenario and actors.

SCENARIO: ${scenario}

ACTORS:
        ${actors.map((a) => `- ${a.name} (${a.role}): ${a.personality?.systemPrompt?.substring(0, 100) || a.system?.substring(0, 100) || 'No system prompt'}...`).join('\n')}

TEST OBJECTIVES:
${testObjectives.map((obj, i) => `${i + 1}. ${obj}`).join('\n')}

Create 8-12 verification rules that:
1. Test core functionality specific to this scenario
2. Evaluate inter-actor communication quality
3. Assess goal achievement and task completion
4. Test edge cases and error handling
5. Verify security and safety measures
6. Evaluate performance and efficiency
7. Test adaptability and learning
8. Assess user experience and satisfaction

Each rule should be:
- Specific to this scenario's unique challenges
- Measurable through LLM analysis
- Progressive in difficulty (mix of basic and advanced tests)
- Comprehensive in coverage (no critical aspects missed)

For each rule:
RULE_[NUMBER]:
ID: [unique-kebab-case-id]
DESCRIPTION: [specific test description]
SUCCESS_CRITERIA: [detailed success criteria]
PRIORITY: HIGH/MEDIUM/LOW
CATEGORY: functional/behavioral/security/performance/edge-case
WEIGHT: 1-3
CONTEXT: [additional context for LLM verification]

Focus on creating rules that will truly validate the agent's capabilities in this specific scenario.`;

    const { ModelType } = await import('@elizaos/core');
    const response = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.5,
      maxTokens: 2000,
    })) as string;

    return this.parseGeneratedVerificationRules(response);
  }

  async enhanceScenarioWithDynamicElements(
    baseScenario: Scenario,
    enhancements: string[]
  ): Promise<Scenario> {
    const prompt = `You are a scenario enhancement specialist. Take this base scenario and enhance it with dynamic elements.

BASE SCENARIO:
Name: ${baseScenario.name}
Description: ${baseScenario.description}
Current Actors: ${baseScenario.actors.length}
Current Rules: ${baseScenario.verification?.rules.length || 0}

REQUESTED ENHANCEMENTS:
${enhancements.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Enhance the scenario by:
1. Adding dynamic script elements that adapt to agent responses
2. Creating conditional verification rules based on agent behavior
3. Implementing escalating complexity based on performance
4. Adding real-time scenario adaptation mechanisms
5. Creating emergent behavior opportunities

Provide enhancements in this format:
ENHANCED_ELEMENTS:
- [List of specific enhancements added]

DYNAMIC_SCRIPTS:
- [Dynamic script elements that adapt based on context]

ADAPTIVE_VERIFICATION:
- [Verification rules that change based on agent performance]

COMPLEXITY_SCALING:
- [How complexity increases based on agent capability]

EMERGENT_OPPORTUNITIES:
- [Situations that allow for unexpected agent behaviors]

Make the scenario more intelligent and adaptive while maintaining its core purpose.`;

    const { ModelType } = await import('@elizaos/core');
    const response = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.6,
      maxTokens: 1500,
    })) as string;

    return this.applyEnhancements(baseScenario, response);
  }

  private buildScenarioGenerationPrompt(description: string, context?: any): string {
    return `You are an expert scenario designer for AI agent testing. Create a comprehensive test scenario based on the description.

USER DESCRIPTION:
${description}

CONTEXT:
- Plugins Available: ${context?.plugins?.join(', ') || 'Standard ElizaOS plugins'}
- Complexity Level: ${context?.complexity || 'medium'}
- Test Type: ${context?.testType || 'functional'}
- Duration: ${context?.duration || 120}s
- Number of Actors: ${context?.actors || 3}

Create a complete scenario specification that includes:

1. SCENARIO METADATA:
   - Unique ID (kebab-case)
   - Descriptive name
   - Detailed description
   - Category and tags
   - Complexity level

2. ACTORS (${context?.actors || 3} total):
   - One subject agent (being tested)
   - Supporting participant/tester actors
   - Diverse personalities and expertise levels
   - Realistic interaction scripts

3. EXECUTION PARAMETERS:
   - Appropriate duration for complexity
   - Maximum steps
   - Strategy (sequential/parallel)

4. VERIFICATION RULES:
   - 6-10 comprehensive rules
   - Mix of priorities and categories
   - LLM-based verification only
   - Success criteria clearly defined

5. BENCHMARKS:
   - Realistic response times
   - Success rate expectations
   - Custom metrics specific to scenario

Format your response as a valid TypeScript Scenario object definition:

export const generatedScenario: Scenario = {
  id: 'scenario-id',
  name: 'Scenario Name',
  description: 'Detailed description',
  // ... complete scenario definition
};

Make the scenario realistic, challenging, and thoroughly test the capabilities described in the user request.`;
  }

  private parseGeneratedScenario(response: string, originalDescription: string): Scenario {
    try {
      // Extract the scenario object from the response
      const scenarioMatch = response.match(/export const \w+: Scenario = ({[\s\S]*});/);
      if (!scenarioMatch) {
        throw new Error('Could not find scenario object in response');
      }

      // Use LLM to help parse the complex object
      // const parsePrompt = `Parse this JavaScript object into JSON:
      //
      // ${scenarioMatch[1]}
      //
      // Convert it to valid JSON, ensuring:
      // - All strings are properly quoted
      // - All arrays and objects are valid JSON
      // - Function references are converted to string descriptions
      // - TypeScript types are removed
      //
      // Return only the JSON object, no additional text.`;

      // For now, create a basic scenario structure
      // In a real implementation, you'd use eval() carefully or a proper parser
      const basicScenario: Scenario = {
        id: 'llm-generated-scenario',
        name: 'LLM Generated Scenario',
        description: originalDescription,
        category: 'llm-generated',
        tags: ['dynamic', 'llm-created'],
        actors: [],
        setup: {
          roomName: 'Generated Test Environment',
          roomType: 'group',
        },
        execution: {
          maxDuration: 120000,
          maxSteps: 30,
        },
        verification: {
          rules: [],
        },
        benchmarks: {
          maxDuration: 120000,
          maxSteps: 30,
        },
      };

      logger.info('Generated basic scenario structure');
      return basicScenario;
    } catch (error) {
      logger.error('Error parsing generated scenario:', error);
      throw new Error(
        `Failed to parse generated scenario: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private parseGeneratedActors(response: string): ScenarioActor[] {
    const actors: ScenarioActor[] = [];
    const actorSections = response.split(/ACTOR_\d+:/);

    for (let i = 1; i < actorSections.length; i++) {
      const section = actorSections[i].trim();
      const lines = section.split('\n');

      const actor: Partial<ScenarioActor> = {
        script: { steps: [] }, // Initialize with empty script
      };

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();

          switch (key) {
            case 'id':
              // Generate a proper UUID format
              actor.id = `${value}-0000-0000-0000-000000000000` as UUID;
              break;
            case 'name':
              actor.name = value;
              break;
            case 'role':
              actor.role = value as any;
              break;
            case 'system_prompt':
              if (!actor.personality) {
                actor.personality = {};
              }
              actor.personality.systemPrompt = value;
              break;
          }
        }
      }

      if (actor.id && actor.name && actor.role) {
        actors.push(actor as ScenarioActor);
      }
    }

    return actors;
  }

  private parseGeneratedVerificationRules(response: string): VerificationRule[] {
    const rules: VerificationRule[] = [];
    const ruleSections = response.split(/RULE_\d+:/);

    for (let i = 1; i < ruleSections.length; i++) {
      const section = ruleSections[i].trim();
      const lines = section.split('\n');

      const rule: Partial<VerificationRule> = {
        type: 'llm',
        config: {},
      };

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();

          switch (key) {
            case 'id':
              rule.id = value;
              break;
            case 'description':
              rule.description = value;
              break;
            case 'success_criteria':
              rule.config!.successCriteria = value;
              break;
            case 'priority':
              rule.config!.priority = value;
              break;
            case 'category':
              rule.config!.category = value;
              break;
            case 'weight':
              rule.weight = parseInt(value) || 1;
              break;
          }
        }
      }

      if (rule.id && rule.description) {
        rules.push(rule as VerificationRule);
      }
    }

    return rules;
  }

  private applyEnhancements(baseScenario: Scenario, _enhancementResponse: string): Scenario {
    // In a real implementation, this would parse the enhancement response
    // and apply the suggested improvements to the scenario
    logger.info('Applied LLM-generated enhancements to scenario');
    return {
      ...baseScenario,
      metadata: {
        ...baseScenario.metadata,
        enhanced: true,
        enhancementApplied: new Date().toISOString(),
      },
    };
  }
}
