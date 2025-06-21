import { logger, type IAgentRuntime } from '@elizaos/core';
import { LLMVerificationEngine } from './llm-verification.js';
import { HybridVerificationEngine } from './hybrid-verification.js';
import type { VerificationRule, VerificationResult, ScenarioContext } from './types.js';

export class ScenarioVerifier {
  private llmEngine: LLMVerificationEngine;
  private hybridEngine: HybridVerificationEngine;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.llmEngine = new LLMVerificationEngine(runtime);
    this.hybridEngine = new HybridVerificationEngine(runtime);
  }

  async verify(rules: VerificationRule[], context: ScenarioContext): Promise<VerificationResult[]> {
    logger.info(`Starting verification of ${rules.length} rules`);

    const results: VerificationResult[] = [];

    // Separate rules by whether they have deterministic configuration
    const deterministicRules = rules.filter((rule) => rule.config?.deterministicType);
    const pureLlmRules = rules.filter((rule) => !rule.config?.deterministicType);

    // Process deterministic rules with hybrid engine (fallback-safe)
    if (deterministicRules.length > 0) {
      logger.info(`Processing ${deterministicRules.length} deterministic rules`);
      const deterministicResults = await this.hybridEngine.verify(deterministicRules, context);
      results.push(...deterministicResults);
    }

    // Process pure LLM rules only if models are available
    if (pureLlmRules.length > 0) {
      logger.info(`Processing ${pureLlmRules.length} LLM rules`);
      try {
        // Check if LLM models are available
        await this.checkLLMAvailability();
        const llmResults = await this.llmEngine.verify(pureLlmRules, context);
        results.push(...llmResults);

        // Generate additional tests only if LLM is working
        const additionalRules = await this.llmEngine.generateAdditionalTests(context, results);
        if (additionalRules.length > 0) {
          logger.info(`Generated ${additionalRules.length} additional verification rules`);
          const additionalResults = await this.llmEngine.verify(additionalRules, context);
          results.push(...additionalResults);
        }
      } catch (error) {
        logger.warn(
          `LLM verification failed, skipping LLM rules: ${error instanceof Error ? error.message : String(error)}`
        );
        // Create failed results for LLM rules
        for (const rule of pureLlmRules) {
          results.push({
            ruleId: rule.id,
            ruleName: rule.description || rule.id,
            passed: false,
            score: 0,
            reason: `LLM verification unavailable: ${error instanceof Error ? error.message : String(error)}`,
            evidence: [],
          });
        }
      }
    }

    return results;
  }

  private async checkLLMAvailability(): Promise<void> {
    try {
      const { ModelType } = await import('@elizaos/core');
      await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: 'test',
        temperature: 0.1,
        maxTokens: 10,
      });
    } catch (error) {
      throw new Error(
        `LLM model not available: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async generateDynamicVerificationRules(
    scenario: ScenarioContext,
    userIntent?: string
  ): Promise<VerificationRule[]> {
    const runtime = (this.llmEngine as any).runtime;

    const prompt = `You are an expert test designer for AI agent evaluation. Generate comprehensive verification rules for this scenario.

SCENARIO: ${scenario.scenario.name}
DESCRIPTION: ${scenario.scenario.description}
USER INTENT: ${userIntent || 'General comprehensive testing'}

ACTORS:
${scenario.scenario.actors.map((a) => `- ${a.name} (${a.role}): ${a.personality?.systemPrompt || a.system || 'No specific prompt'}`).join('\n')}

Generate 5-8 verification rules that thoroughly test:
1. Core functionality and expected behaviors
2. Edge cases and error handling
3. Inter-actor communication quality
4. Goal achievement and task completion
5. Unexpected or emergent behaviors
6. Security and safety considerations
7. Performance and efficiency aspects

For each rule, provide:
- ID: A unique identifier (use kebab-case)
- DESCRIPTION: What the rule tests (be specific)
- SUCCESS_CRITERIA: Clear, measurable criteria for passing
- PRIORITY: HIGH/MEDIUM/LOW
- CATEGORY: functional/behavioral/performance/security/edge-case

Format your response as:
RULE_1:
ID: [unique-id]
DESCRIPTION: [what this tests]
SUCCESS_CRITERIA: [how to determine success]
PRIORITY: [HIGH/MEDIUM/LOW]
CATEGORY: [category]

Continue with RULE_2, RULE_3, etc.`;

    const { ModelType } = await import('@elizaos/core');
    const response = (await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.4,
      maxTokens: 2000,
    })) as string;

    return this.parseGeneratedRules(response);
  }

  private parseGeneratedRules(response: string): VerificationRule[] {
    const rules: VerificationRule[] = [];
    const sections = response.split(/RULE_\d+:/);

    for (let i = 1; i < sections.length; i++) {
      const section = sections[i].trim();
      const lines = section.split('\n');

      let id = '';
      let description = '';
      let successCriteria = '';
      let priority = 'MEDIUM';
      let category = 'functional';

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();

          switch (key) {
            case 'id':
              id = value;
              break;
            case 'description':
              description = value;
              break;
            case 'success_criteria':
              successCriteria = value;
              break;
            case 'priority':
              priority = value;
              break;
            case 'category':
              category = value;
              break;
          }
        }
      }

      if (id && description) {
        rules.push({
          id,
          type: 'llm',
          description,
          weight: priority === 'HIGH' ? 3 : priority === 'LOW' ? 1 : 2,
          config: {
            successCriteria,
            priority,
            category,
            dynamicallyGenerated: true,
          },
        });
      }
    }

    logger.info(`Parsed ${rules.length} verification rules from LLM response`);
    return rules;
  }
}
