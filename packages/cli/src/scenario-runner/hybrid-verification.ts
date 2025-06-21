import { logger, type IAgentRuntime } from '@elizaos/core';
import type { VerificationRule, VerificationResult, ScenarioContext } from './types.js';

export interface DeterministicRule {
  type: 'deterministic';
  verifier: (context: ScenarioContext) => VerificationResult;
  llmEnhancement?: boolean; // Optional LLM analysis for richer feedback
}

export interface LLMRule {
  type: 'llm';
  prompt: string;
  fallback: (context: ScenarioContext) => VerificationResult; // Deterministic fallback
}

export class HybridVerificationEngine {
  private runtime: IAgentRuntime;
  private cache = new Map<string, VerificationResult>();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async verify(rules: VerificationRule[], context: ScenarioContext): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];

    for (const rule of rules) {
      // Always run deterministic verification first
      const deterministicResult = this.runDeterministicVerification(rule, context);

      // Only use LLM for enhancement, not primary decision
      let enhancedResult = deterministicResult;
      if (rule.config.llmEnhancement && deterministicResult.passed) {
        try {
          enhancedResult = await this.enhanceWithLLM(rule, context, deterministicResult);
        } catch (error) {
          logger.warn(
            `LLM enhancement failed for rule ${rule.id}, using deterministic result:`,
            error
          );
          // Deterministic result is preserved
        }
      }

      results.push(enhancedResult);
    }

    return results;
  }

  private runDeterministicVerification(
    rule: VerificationRule,
    context: ScenarioContext
  ): VerificationResult {
    const cacheKey = `${rule.id}-${this.hashContext(context)}`;

    // Check cache for deterministic results
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let result: VerificationResult;

    switch (rule.config.deterministicType) {
      case 'message_count':
        result = this.verifyMessageCount(rule, context);
        break;
      case 'response_time':
        result = this.verifyResponseTime(rule, context);
        break;
      case 'keyword_presence':
        result = this.verifyKeywordPresence(rule, context);
        break;
      case 'action_sequence':
        result = this.verifyActionSequence(rule, context);
        break;
      case 'error_handling':
        result = this.verifyErrorHandling(rule, context);
        break;
      case 'security_compliance':
        result = this.verifySecurityCompliance(rule, context);
        break;
      default:
        result = {
          ruleId: rule.id,
          ruleName: rule.description || rule.id,
          passed: false,
          score: 0,
          reason: `Unknown deterministic verification type: ${rule.config.deterministicType}`,
          evidence: [],
        };
    }

    // Cache deterministic results
    this.cache.set(cacheKey, result);
    return result;
  }

  private verifyMessageCount(rule: VerificationRule, context: ScenarioContext): VerificationResult {
    const actualCount = context.transcript.length;
    const expectedMin = rule.config.minMessages || 0;
    const expectedMax = rule.config.maxMessages || Infinity;

    const passed = actualCount >= expectedMin && actualCount <= expectedMax;

    return {
      ruleId: rule.id,
      ruleName: rule.description || rule.id,
      passed,
      score: passed ? 1.0 : 0.0,
      reason: `Expected ${expectedMin}-${expectedMax} messages, got ${actualCount}`,
      evidence: [`Message count: ${actualCount}`],
    };
  }

  private verifyResponseTime(rule: VerificationRule, context: ScenarioContext): VerificationResult {
    const maxResponseTime = rule.config.maxResponseTimeMs || 5000;
    // Note: ScenarioMessage doesn't have responseTime property in current type definition
    // Using timestamp differences as a workaround
    const responseTimes: number[] = [];

    for (let i = 1; i < context.transcript.length; i++) {
      const timeDiff = context.transcript[i].timestamp - context.transcript[i - 1].timestamp;
      responseTimes.push(timeDiff);
    }

    const avgResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : 0;

    const passed = avgResponseTime <= maxResponseTime;

    return {
      ruleId: rule.id,
      ruleName: rule.description || rule.id,
      passed,
      score: passed ? 1.0 : Math.max(0, 1 - (avgResponseTime - maxResponseTime) / maxResponseTime),
      reason: `Average response time ${avgResponseTime}ms, max allowed ${maxResponseTime}ms`,
      evidence: [`Average response time: ${avgResponseTime}ms`],
    };
  }

  private verifyKeywordPresence(
    rule: VerificationRule,
    context: ScenarioContext
  ): VerificationResult {
    const requiredKeywords = rule.config.requiredKeywords || [];
    const forbiddenKeywords = rule.config.forbiddenKeywords || [];

    const transcript = context.transcript
      .map((msg) => msg.content?.text || '')
      .join(' ')
      .toLowerCase();

    const missingRequired = requiredKeywords.filter(
      (keyword: string) => !transcript.includes(keyword.toLowerCase())
    );

    const foundForbidden = forbiddenKeywords.filter((keyword: string) =>
      transcript.includes(keyword.toLowerCase())
    );

    const passed = missingRequired.length === 0 && foundForbidden.length === 0;

    return {
      ruleId: rule.id,
      ruleName: rule.description || rule.id,
      passed,
      score: passed ? 1.0 : 0.0,
      reason: `Missing required: [${missingRequired.join(', ')}], Found forbidden: [${foundForbidden.join(', ')}]`,
      evidence: [
        ...missingRequired.map((k: string) => `Missing: ${k}`),
        ...foundForbidden.map((k: string) => `Forbidden: ${k}`),
      ],
    };
  }

  private verifyActionSequence(
    rule: VerificationRule,
    context: ScenarioContext
  ): VerificationResult {
    const expectedSequence = rule.config.expectedActions || [];
    const actualActions = context.transcript
      .filter((msg) => msg.metadata?.actionType)
      .map((msg) => msg.metadata!.actionType);

    let sequenceMatch = true;
    let lastFoundIndex = -1;

    for (const expectedAction of expectedSequence) {
      const foundIndex = actualActions.indexOf(expectedAction, lastFoundIndex + 1);
      if (foundIndex === -1) {
        sequenceMatch = false;
        break;
      }
      lastFoundIndex = foundIndex;
    }

    return {
      ruleId: rule.id,
      ruleName: rule.description || rule.id,
      passed: sequenceMatch,
      score: sequenceMatch ? 1.0 : 0.0,
      reason: `Expected sequence: [${expectedSequence.join(' → ')}], Got: [${actualActions.join(' → ')}]`,
      evidence: [`Action sequence: ${actualActions.join(' → ')}`],
    };
  }

  private verifyErrorHandling(
    rule: VerificationRule,
    context: ScenarioContext
  ): VerificationResult {
    const errorMessages = context.transcript.filter(
      (msg) => msg.content?.text?.toLowerCase().includes('error') || msg.metadata?.isError
    );

    const expectedErrorCount = rule.config.expectedErrors || 0;
    const maxAllowedErrors = rule.config.maxAllowedErrors || 0;

    const actualErrorCount = errorMessages.length;
    const passed = actualErrorCount >= expectedErrorCount && actualErrorCount <= maxAllowedErrors;

    return {
      ruleId: rule.id,
      ruleName: rule.description || rule.id,
      passed,
      score: passed ? 1.0 : 0.0,
      reason: `Expected ${expectedErrorCount} errors (max ${maxAllowedErrors}), found ${actualErrorCount}`,
      evidence: errorMessages.map((msg) => `Error: ${msg.content?.text}`),
    };
  }

  private verifySecurityCompliance(
    rule: VerificationRule,
    context: ScenarioContext
  ): VerificationResult {
    const sensitivePatterns = rule.config.sensitivePatterns || [
      /api[_-]?key/i,
      /password/i,
      /secret/i,
      /token/i,
      /\b[A-Za-z0-9]{20,}\b/, // Long alphanumeric strings (potential secrets)
    ];

    const violations: string[] = [];

    for (const msg of context.transcript) {
      const text = msg.content?.text || '';
      for (const pattern of sensitivePatterns) {
        if (pattern.test(text)) {
          violations.push(`Potential secret exposure in message: ${text.substring(0, 50)}...`);
        }
      }
    }

    const passed = violations.length === 0;

    return {
      ruleId: rule.id,
      ruleName: rule.description || rule.id,
      passed,
      score: passed ? 1.0 : Math.max(0, 1 - violations.length * 0.2),
      reason: passed
        ? 'No security violations detected'
        : `Found ${violations.length} potential violations`,
      evidence: violations,
    };
  }

  private async enhanceWithLLM(
    rule: VerificationRule,
    context: ScenarioContext,
    deterministicResult: VerificationResult
  ): Promise<VerificationResult> {
    // Only enhance successful deterministic results
    if (!deterministicResult.passed) {
      return deterministicResult;
    }

    const transcript = this.formatTranscript(context.transcript);

    const prompt = `You are enhancing a test result with additional insights. The test already PASSED deterministically.

DETERMINISTIC RESULT:
- Rule: ${rule.description}
- Status: PASSED
- Score: ${deterministicResult.score}
- Reasoning: ${deterministicResult.reason}

TRANSCRIPT:
${transcript}

Provide additional insights about WHY this passed and what quality indicators you observe. Keep the PASSED status but enhance the reasoning and evidence.

Format:
ENHANCED_REASONING: [More detailed explanation]
QUALITY_INDICATORS: [List of positive observations]
IMPROVEMENT_SUGGESTIONS: [Optional suggestions for even better performance]`;

    try {
      const { ModelType } = await import('@elizaos/core');
      const response = (await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        temperature: 0.2,
        maxTokens: 300,
      })) as string;

      const enhancedReasoning =
        this.extractSection(response, 'ENHANCED_REASONING') || deterministicResult.reason;
      const qualityIndicators =
        this.extractSection(response, 'QUALITY_INDICATORS')?.split('\n') || [];
      // const _improvements = this.extractSection(response, 'IMPROVEMENT_SUGGESTIONS');

      return {
        ...deterministicResult,
        reason: enhancedReasoning,
        evidence: [...(deterministicResult.evidence || []), ...qualityIndicators],
      };
    } catch (error) {
      logger.warn(`LLM enhancement failed: ${error}`);
      return deterministicResult;
    }
  }

  private formatTranscript(transcript: any[]): string {
    return transcript
      .map((msg, i) => `[${i + 1}] ${msg.actorId}: ${msg.content?.text || ''}`)
      .join('\n');
  }

  private extractSection(text: string, section: string): string | undefined {
    const regex = new RegExp(`${section}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, 'i');
    const match = text.match(regex);
    return match?.[1]?.trim();
  }

  private hashContext(context: ScenarioContext): string {
    // Simple hash of context for caching
    const content = context.transcript.map((m) => m.content?.text).join('');
    return Buffer.from(content).toString('base64').substring(0, 10);
  }
}
