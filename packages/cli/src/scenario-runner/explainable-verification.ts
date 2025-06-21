// import { logger } from '@elizaos/core'; // Available for logging if needed
import type { VerificationResult, ScenarioContext } from './types.js';

export interface ExplanationConfig {
  includeStepByStep: boolean;
  includeCounterExamples: boolean;
  includeFixSuggestions: boolean;
  includeDataFlow: boolean;
  verbosityLevel: 'minimal' | 'standard' | 'detailed' | 'debug';
}

export interface ExplainableResult extends VerificationResult {
  explanation: {
    decisionPath: DecisionStep[];
    dataFlow: DataFlowStep[];
    counterExamples: CounterExample[];
    fixSuggestions: FixSuggestion[];
    confidenceFactors: ConfidenceFactor[];
  };
}

export interface DecisionStep {
  step: number;
  description: string;
  input: any;
  output: any;
  logic: string;
  confidence: number;
}

export interface DataFlowStep {
  stage: string;
  input: string;
  transformations: string[];
  output: string;
}

export interface CounterExample {
  description: string;
  whatWouldMakeItPass: string;
  whatWouldMakeItFail: string;
  similarFailures: string[];
}

export interface FixSuggestion {
  type: 'agent_behavior' | 'scenario_design' | 'verification_rule';
  priority: 'low' | 'medium' | 'high';
  description: string;
  implementation: string;
  estimatedImpact: number; // 0-1
}

export interface ConfidenceFactor {
  factor: string;
  impact: 'positive' | 'negative' | 'neutral';
  weight: number;
  explanation: string;
}

export class ExplainableVerificationEngine {
  constructor(_config: ExplanationConfig) {}

  async explainableVerify(rule: any, context: ScenarioContext): Promise<ExplainableResult> {
    const decisionPath: DecisionStep[] = [];
    const dataFlow: DataFlowStep[] = [];

    // Step 1: Data preprocessing
    this.recordDataFlow(dataFlow, 'preprocessing', context);

    // Step 2: Rule analysis
    const ruleAnalysis = this.analyzeRule(rule);
    this.recordDecisionStep(
      decisionPath,
      1,
      'Rule Analysis',
      rule,
      ruleAnalysis,
      'Parsed rule requirements and constraints'
    );

    // Step 3: Context evaluation
    const contextEval = this.evaluateContext(context, rule);
    this.recordDecisionStep(
      decisionPath,
      2,
      'Context Evaluation',
      context,
      contextEval,
      'Analyzed conversation context against rule requirements'
    );

    // Step 4: Core verification logic
    const coreResult = this.performCoreVerification(rule, context, decisionPath);

    // Step 5: Confidence analysis
    const confidenceFactors = this.analyzeConfidence(rule, context, coreResult);

    // Step 6: Generate explanations
    const counterExamples = this.generateCounterExamples(rule, context, coreResult);
    const fixSuggestions = this.generateFixSuggestions(rule, context, coreResult);

    return {
      ...coreResult,
      explanation: {
        decisionPath,
        dataFlow,
        counterExamples,
        fixSuggestions,
        confidenceFactors,
      },
    };
  }

  private recordDataFlow(dataFlow: DataFlowStep[], stage: string, context: ScenarioContext): void {
    const transformations: string[] = [];

    // Track what transformations are applied to the data
    if (context.transcript.length > 0) {
      transformations.push(`Extracted ${context.transcript.length} messages`);
    }

    const totalCharacters = context.transcript
      .map((msg) => msg.content?.text || '')
      .join('').length;
    transformations.push(`Total text: ${totalCharacters} characters`);

    dataFlow.push({
      stage,
      input: `${context.transcript.length} messages`,
      transformations,
      output: `Processed conversation data`,
    });
  }

  private recordDecisionStep(
    decisionPath: DecisionStep[],
    step: number,
    description: string,
    input: any,
    output: any,
    logic: string,
    confidence: number = 0.9
  ): void {
    decisionPath.push({
      step,
      description,
      input: this.summarizeInput(input),
      output: this.summarizeOutput(output),
      logic,
      confidence,
    });
  }

  private analyzeRule(rule: any): any {
    return {
      type: rule.config?.deterministicType || 'unknown',
      requirements: this.extractRequirements(rule),
      constraints: this.extractConstraints(rule),
      complexity: this.calculateRuleComplexity(rule),
    };
  }

  private evaluateContext(context: ScenarioContext, rule: any): any {
    return {
      messageCount: context.transcript.length,
      averageMessageLength: this.calculateAverageMessageLength(context),
      actorParticipation: this.analyzeActorParticipation(context),
      conversationFlow: this.analyzeConversationFlow(context),
      relevanceToRule: this.calculateRelevance(context, rule),
    };
  }

  private performCoreVerification(
    rule: any,
    context: ScenarioContext,
    decisionPath: DecisionStep[]
  ): VerificationResult {
    // Example: Message count verification with detailed tracking
    if (rule.config?.deterministicType === 'message_count') {
      const actualCount = context.transcript.length;
      const expectedMin = rule.config.minMessages || 0;
      const expectedMax = rule.config.maxMessages || Infinity;

      this.recordDecisionStep(
        decisionPath,
        3,
        'Message Count Check',
        { actualCount, expectedMin, expectedMax },
        { withinRange: actualCount >= expectedMin && actualCount <= expectedMax },
        `Checking if ${actualCount} is between ${expectedMin} and ${expectedMax}`,
        1.0 // High confidence for deterministic check
      );

      const passed = actualCount >= expectedMin && actualCount <= expectedMax;

      return {
        ruleId: rule.id,
        passed,
        score: passed ? 1.0 : this.calculatePartialScore(actualCount, expectedMin, expectedMax),
        reason: this.buildDetailedReasoning(actualCount, expectedMin, expectedMax, passed),
        ruleName: rule.description || rule.id,
        evidence: this.collectEvidence(context, rule),
      };
    }

    // Fallback for other rule types
    return {
      ruleId: rule.id,
      passed: false,
      score: 0,
      reason: 'Rule type not supported by explainable verification',
      ruleName: rule.description || rule.id,
      evidence: [],
    };
  }

  private analyzeConfidence(
    rule: any,
    context: ScenarioContext,
    result: VerificationResult
  ): ConfidenceFactor[] {
    const factors: ConfidenceFactor[] = [];

    // Data quality factors
    if (context.transcript.length > 5) {
      factors.push({
        factor: 'Sufficient conversation data',
        impact: 'positive',
        weight: 0.2,
        explanation: `${context.transcript.length} messages provide good analysis basis`,
      });
    } else {
      factors.push({
        factor: 'Limited conversation data',
        impact: 'negative',
        weight: 0.3,
        explanation: `Only ${context.transcript.length} messages may not be representative`,
      });
    }

    // Rule clarity factors
    if (rule.config?.deterministicType) {
      factors.push({
        factor: 'Clear verification criteria',
        impact: 'positive',
        weight: 0.3,
        explanation: 'Deterministic rule provides objective verification',
      });
    }

    // Result consistency factors
    if (result.score !== undefined && (result.score > 0.8 || result.score < 0.2)) {
      factors.push({
        factor: 'Clear outcome',
        impact: 'positive',
        weight: 0.2,
        explanation: `Score ${result.score} indicates unambiguous result`,
      });
    } else if (result.score !== undefined) {
      factors.push({
        factor: 'Ambiguous outcome',
        impact: 'negative',
        weight: 0.2,
        explanation: `Score ${result.score} suggests borderline case`,
      });
    }

    return factors;
  }

  private generateCounterExamples(
    rule: any,
    context: ScenarioContext,
    result: VerificationResult
  ): CounterExample[] {
    const examples: CounterExample[] = [];

    if (rule.config?.deterministicType === 'message_count') {
      const actualCount = context.transcript.length;
      const expectedMin = rule.config.minMessages || 0;
      const expectedMax = rule.config.maxMessages || Infinity;

      examples.push({
        description: 'Message count verification example',
        whatWouldMakeItPass: `Having between ${expectedMin} and ${expectedMax} messages (currently ${actualCount})`,
        whatWouldMakeItFail:
          expectedMin > 0
            ? `Having fewer than ${expectedMin} or more than ${expectedMax} messages`
            : `Having more than ${expectedMax} messages`,
        similarFailures: this.findSimilarFailures(rule, result),
      });
    }

    return examples;
  }

  private generateFixSuggestions(
    rule: any,
    context: ScenarioContext,
    result: VerificationResult
  ): FixSuggestion[] {
    const suggestions: FixSuggestion[] = [];

    if (!result.passed) {
      if (rule.config?.deterministicType === 'message_count') {
        const actualCount = context.transcript.length;
        const expectedMin = rule.config.minMessages || 0;

        if (actualCount < expectedMin) {
          suggestions.push({
            type: 'scenario_design',
            priority: 'medium',
            description: 'Increase conversation length',
            implementation: `Add more conversation steps to reach minimum ${expectedMin} messages`,
            estimatedImpact: 0.8,
          });

          suggestions.push({
            type: 'agent_behavior',
            priority: 'low',
            description: 'Encourage longer responses',
            implementation: 'Modify agent prompts to generate more detailed responses',
            estimatedImpact: 0.4,
          });
        }
      }

      // Generic suggestions
      suggestions.push({
        type: 'verification_rule',
        priority: 'low',
        description: 'Review rule requirements',
        implementation: 'Consider if the verification criteria are appropriate for this scenario',
        estimatedImpact: 0.6,
      });
    }

    return suggestions;
  }

  // Helper methods
  private summarizeInput(input: any): string {
    if (typeof input === 'object') {
      return JSON.stringify(input, null, 2).substring(0, 200) + '...';
    }
    return String(input).substring(0, 200);
  }

  private summarizeOutput(output: any): string {
    return this.summarizeInput(output);
  }

  private extractRequirements(rule: any): string[] {
    const requirements: string[] = [];
    if (rule.config?.minMessages) requirements.push(`At least ${rule.config.minMessages} messages`);
    if (rule.config?.maxMessages) requirements.push(`At most ${rule.config.maxMessages} messages`);
    if (rule.config?.requiredKeywords)
      requirements.push(`Contains keywords: ${rule.config.requiredKeywords.join(', ')}`);
    return requirements;
  }

  private extractConstraints(rule: any): string[] {
    const constraints: string[] = [];
    if (rule.config?.maxResponseTimeMs)
      constraints.push(`Response time under ${rule.config.maxResponseTimeMs}ms`);
    if (rule.config?.forbiddenKeywords)
      constraints.push(`Must not contain: ${rule.config.forbiddenKeywords.join(', ')}`);
    return constraints;
  }

  private calculateRuleComplexity(rule: any): number {
    let complexity = 0;
    if (rule.config?.minMessages || rule.config?.maxMessages) complexity += 1;
    if (rule.config?.requiredKeywords?.length) complexity += rule.config.requiredKeywords.length;
    if (rule.config?.forbiddenKeywords?.length) complexity += rule.config.forbiddenKeywords.length;
    return complexity;
  }

  private calculateAverageMessageLength(context: ScenarioContext): number {
    const totalLength = context.transcript
      .map((msg) => msg.content?.text?.length || 0)
      .reduce((a, b) => a + b, 0);
    return context.transcript.length > 0 ? totalLength / context.transcript.length : 0;
  }

  private analyzeActorParticipation(context: ScenarioContext): Record<string, number> {
    const participation: Record<string, number> = {};
    for (const msg of context.transcript) {
      const actorId = msg.actorId || 'unknown';
      participation[actorId] = (participation[actorId] || 0) + 1;
    }
    return participation;
  }

  private analyzeConversationFlow(context: ScenarioContext): string {
    if (context.transcript.length < 2) return 'insufficient_data';
    if (context.transcript.length < 5) return 'brief_exchange';
    if (context.transcript.length < 15) return 'moderate_conversation';
    return 'extended_conversation';
  }

  private calculateRelevance(context: ScenarioContext, rule: any): number {
    // Simple relevance calculation based on rule keywords in transcript
    const ruleKeywords = [
      ...(rule.config?.requiredKeywords || []),
      ...(rule.description?.split(' ') || []),
    ].filter((k) => k.length > 3);

    const transcript = context.transcript
      .map((msg) => msg.content?.text || '')
      .join(' ')
      .toLowerCase();

    const foundKeywords = ruleKeywords.filter((keyword) =>
      transcript.includes(keyword.toLowerCase())
    );

    return ruleKeywords.length > 0 ? foundKeywords.length / ruleKeywords.length : 0.5;
  }

  private calculatePartialScore(actual: number, min: number, max: number): number {
    if (actual < min) {
      return Math.max(0, (actual / min) * 0.5);
    }
    if (actual > max) {
      return Math.max(0, 1 - ((actual - max) / max) * 0.5);
    }
    return 1.0;
  }

  private buildDetailedReasoning(
    actual: number,
    min: number,
    max: number,
    passed: boolean
  ): string {
    let reasoning = `Message count verification: found ${actual} messages, `;
    reasoning += `expected between ${min} and ${max}. `;

    if (passed) {
      reasoning += 'Requirement satisfied.';
    } else if (actual < min) {
      reasoning += `Insufficient messages (need ${min - actual} more).`;
    } else {
      reasoning += `Too many messages (${actual - max} over limit).`;
    }

    return reasoning;
  }

  private collectEvidence(context: ScenarioContext, _rule: any): string[] {
    const evidence: string[] = [];
    evidence.push(`Total messages: ${context.transcript.length}`);

    const actors = new Set(context.transcript.map((msg) => msg.actorId));
    evidence.push(`Unique actors: ${actors.size}`);

    const avgLength = this.calculateAverageMessageLength(context);
    evidence.push(`Average message length: ${avgLength.toFixed(1)} characters`);

    return evidence;
  }

  private findSimilarFailures(_rule: any, _result: VerificationResult): string[] {
    // In a real implementation, this would query a database of past failures
    return [
      'Similar scenario failed due to insufficient conversation length',
      'Related test failed with message count of 3 when 5+ was required',
    ];
  }
}
