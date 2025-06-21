import { type IAgentRuntime, logger } from '@elizaos/core';
import type {
  VerificationRule,
  VerificationResult,
  ScenarioContext,
  ScenarioMessage,
} from './types.js';

export class LLMVerificationEngine {
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async verify(rules: VerificationRule[], context: ScenarioContext): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];

    for (const rule of rules) {
      try {
        const result = await this.verifyRule(rule, context);
        results.push(result);
      } catch (error) {
        logger.error(`Error verifying rule ${rule.id}:`, error);
        results.push({
          ruleId: rule.id,
          ruleName: rule.description || rule.id,
          passed: false,
          score: 0,
          reason: `Verification failed due to error: ${error instanceof Error ? error.message : String(error)}`,
          evidence: [],
        });
      }
    }

    return results;
  }

  private async verifyRule(
    rule: VerificationRule,
    context: ScenarioContext
  ): Promise<VerificationResult> {
    const prompt = this.buildVerificationPrompt(rule, context);

    logger.debug(`Verifying rule ${rule.id} with LLM`);

    const { ModelType } = await import('@elizaos/core');
    const response = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.1, // Low temperature for consistent verification
      maxTokens: 1000,
    })) as string;

    return this.interpretVerificationResponse(rule.id, response, context);
  }

  private buildVerificationPrompt(rule: VerificationRule, context: ScenarioContext): string {
    const transcript = this.formatTranscript(context.transcript);
    const scenario = context.scenario;

    return `You are an expert AI system evaluator. Your task is to analyze a conversation transcript and determine if a specific criterion has been met.

SCENARIO CONTEXT:
- Scenario: ${scenario.name}
- Description: ${scenario.description}
- Actors involved: ${scenario.actors.map((a) => `${a.name} (${a.role})`).join(', ')}

VERIFICATION RULE:
- Rule ID: ${rule.id}
- Description: ${rule.description}
- Success Criteria: ${this.extractSuccessCriteria(rule)}

CONVERSATION TRANSCRIPT:
${transcript}

EVALUATION INSTRUCTIONS:
1. Carefully analyze the entire conversation transcript
2. Determine if the success criteria has been met based on the conversation flow, content, and context
3. Consider the roles and expected behaviors of each actor
4. Look for evidence that supports or contradicts the success criteria
5. Consider edge cases, implicit behaviors, and conversation dynamics

Please provide your evaluation in the following format:

DECISION: [PASS/FAIL]
CONFIDENCE: [0.0-1.0]
REASONING: [Detailed explanation of your decision, citing specific evidence from the transcript]
EVIDENCE: [List specific messages or behaviors that support your decision]
SUGGESTIONS: [If failed, what would need to change for this to pass?]

Your evaluation should be thorough, objective, and based entirely on the evidence in the transcript.`;
  }

  private extractSuccessCriteria(rule: VerificationRule): string {
    // Use LLM to dynamically understand and articulate success criteria
    if (rule.config) {
      const configStr = Object.entries(rule.config)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      return `${rule.description} (Configuration: ${configStr})`;
    }
    return rule.description;
  }

  private formatTranscript(transcript: ScenarioMessage[]): string {
    if (transcript.length === 0) {
      return '[No messages in transcript]';
    }

    return transcript
      .map((msg, index) => {
        const timestamp = new Date(msg.timestamp).toISOString();
        const sender = msg.actorId || 'System';
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content?.text || JSON.stringify(msg.content);

        return `[${index + 1}] ${timestamp} - ${sender}: ${content}`;
      })
      .join('\n');
  }

  private async interpretVerificationResponse(
    ruleId: string,
    response: string,
    _context: ScenarioContext
  ): Promise<VerificationResult> {
    // Use another LLM call to extract structured data from the verification response
    const extractionPrompt = `Parse the following verification response and extract the key information:

VERIFICATION RESPONSE:
${response}

Extract and return ONLY the following information in this exact format:
DECISION: [the pass/fail decision]
CONFIDENCE: [the confidence score as a decimal]
REASONING: [the reasoning provided]
EVIDENCE: [comma-separated list of evidence items]
SUGGESTIONS: [suggestions for improvement if any]

If any field is missing, use "Not provided" for text fields and 0.5 for confidence.`;

    const { ModelType } = await import('@elizaos/core');
    const extractedResponse = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: extractionPrompt,
      temperature: 0.0,
      maxTokens: 500,
    })) as string;

    return this.parseExtractedResponse(ruleId, extractedResponse, response);
  }

  private parseExtractedResponse(
    ruleId: string,
    extractedResponse: string,
    _originalResponse: string
  ): VerificationResult {
    try {
      const lines = extractedResponse.split('\n');
      const data: Record<string, string> = {};

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();
          data[key] = value;
        }
      }

      const decision = data.decision?.toLowerCase() || '';
      const passed = decision.includes('pass') && !decision.includes('fail');
      const confidence = parseFloat(data.confidence || '0.5');
      const reasoning = data.reasoning || 'No reasoning provided';
      const evidenceText = data.evidence || '';

      const evidence = evidenceText
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item !== 'Not provided');

      return {
        ruleId,
        ruleName: ruleId,
        passed,
        score: confidence,
        reason: reasoning,
        evidence,
      };
    } catch (error) {
      logger.error('Error parsing verification response:', error);
      return {
        ruleId,
        ruleName: ruleId,
        passed: false,
        score: 0,
        reason: `Failed to parse verification response: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [],
      };
    }
  }

  async generateAdditionalTests(
    scenario: ScenarioContext,
    currentResults: VerificationResult[]
  ): Promise<VerificationRule[]> {
    const transcript = this.formatTranscript(scenario.transcript);
    const failedRules = currentResults.filter((r) => !r.passed);

    const prompt = `You are an expert test designer for AI agent evaluation. Based on the scenario and current test results, suggest additional verification rules that would provide more comprehensive testing.

SCENARIO: ${scenario.scenario.name}
DESCRIPTION: ${scenario.scenario.description}

CONVERSATION TRANSCRIPT:
${transcript}

CURRENT TEST RESULTS:
${currentResults.map((r) => `- ${r.ruleId}: ${r.passed ? 'PASS' : 'FAIL'} (${r.reason})`).join('\n')}

FAILED TESTS:
${failedRules.map((r) => `- ${r.ruleId}: ${r.reason}`).join('\n')}

Based on this information, suggest 3-5 additional verification rules that would:
1. Test aspects not covered by current rules
2. Provide more granular testing of failed areas
3. Test edge cases or potential failure modes
4. Verify implicit behaviors or requirements

For each suggested rule, provide:
- ID: A unique identifier
- DESCRIPTION: What the rule tests
- SUCCESS_CRITERIA: Clear criteria for passing
- PRIORITY: HIGH/MEDIUM/LOW

Format your response as:
RULE_1:
ID: [unique-id]
DESCRIPTION: [what this tests]
SUCCESS_CRITERIA: [how to determine success]
PRIORITY: [HIGH/MEDIUM/LOW]

RULE_2:
...`;

    const { ModelType } = await import('@elizaos/core');
    const response = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.3,
      maxTokens: 1500,
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
          },
        });
      }
    }

    return rules;
  }
}
