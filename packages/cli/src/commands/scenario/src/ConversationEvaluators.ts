// File: packages/cli/src/commands/scenario/src/ConversationEvaluators.ts
// Specialized evaluators for conversation scenarios

import { AgentRuntime, ModelType } from '@elizaos/core';
import { ExecutionResult } from './providers';
import { Evaluator, EvaluationResult } from './EvaluationEngine';
import { Evaluation as EvaluationSchema } from './schema';

/**
 * Evaluates conversation length against specified criteria
 */
export class ConversationLengthEvaluator implements Evaluator {
  async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
    const metadata = (runResult as any).conversationMetadata;
    if (!metadata) {
      return {
        success: false,
        message: 'No conversation metadata found - not a conversation step',
      };
    }

    const { turnCount } = metadata;
    const { min_turns, max_turns, optimal_turns, target_range } = params as any;

    let success = true;
    let message = `Conversation lasted ${turnCount} turns`;
    const issues: string[] = [];

    // Check minimum turns
    if (min_turns && turnCount < min_turns) {
      success = false;
      issues.push(`below minimum of ${min_turns}`);
    }

    // Check maximum turns
    if (max_turns && turnCount > max_turns) {
      success = false;
      issues.push(`above maximum of ${max_turns}`);
    }

    // Check target range
    if (target_range && target_range.length === 2) {
      const [min, max] = target_range;
      if (turnCount < min || turnCount > max) {
        success = false;
        issues.push(`outside target range ${min}-${max}`);
      }
    }

    // Add optimal turns information
    if (optimal_turns) {
      const distance = Math.abs(turnCount - optimal_turns);
      if (distance === 0) {
        message += ` (optimal)`;
      } else {
        message += ` (${distance} turns from optimal ${optimal_turns})`;
      }
    }

    // Add issues to message
    if (issues.length > 0) {
      message += ` - ${issues.join(', ')}`;
    }

    return { success, message };
  }
}

/**
 * Evaluates conversation flow patterns
 */
export class ConversationFlowEvaluator implements Evaluator {
  async evaluate(
    params: EvaluationSchema,
    runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EvaluationResult> {
    const { required_patterns, flow_quality_threshold } = params as any;
    const conversationText = runResult.stdout;

    const detectedPatterns: string[] = [];
    const missedPatterns: string[] = [];

    for (const pattern of required_patterns) {
      const detected = await this.detectPattern(pattern, conversationText, runtime);
      if (detected) {
        detectedPatterns.push(pattern);
      } else {
        missedPatterns.push(pattern);
      }
    }

    const detectionRate = detectedPatterns.length / required_patterns.length;
    const threshold = flow_quality_threshold || 0.7;
    const success = detectionRate >= threshold;

    let message = `Flow analysis: ${detectedPatterns.length}/${required_patterns.length} patterns detected`;

    if (detectedPatterns.length > 0) {
      message += ` (✓ ${detectedPatterns.join(', ')})`;
    }

    if (missedPatterns.length > 0) {
      message += ` (✗ ${missedPatterns.join(', ')})`;
    }

    return { success, message };
  }

  private async detectPattern(
    pattern: string,
    conversationText: string,
    runtime: AgentRuntime
  ): Promise<boolean> {
    const patternPrompts = {
      question_then_answer:
        'Does this conversation contain instances where the agent asks a question and the user provides an answer?',
      problem_then_solution:
        'Does this conversation show the user stating a problem and the agent providing a solution?',
      clarification_cycle:
        'Does this conversation include back-and-forth clarification between user and agent?',
      empathy_then_solution: 'Does the agent show empathy before providing solutions?',
      escalation_pattern: 'Does the conversation include appropriate escalation when needed?',
    };

    const prompt = (patternPrompts as Record<string, string>)[pattern];
    if (!prompt) {
      console.warn(`[ConversationFlowEvaluator] Unknown pattern: ${pattern}`);
      return false;
    }

    const analysisPrompt = `${prompt}

Conversation:
${conversationText}

Analyze the conversation and respond with only 'yes' or 'no'.`;

    try {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [{ role: 'user', content: analysisPrompt }],
        temperature: 0.1,
      });

      return response.toLowerCase().includes('yes');
    } catch (error) {
      console.error(`[ConversationFlowEvaluator] Pattern detection failed for ${pattern}:`, error);
      return false;
    }
  }
}

/**
 * Evaluates user satisfaction based on conversation content
 */
export class UserSatisfactionEvaluator implements Evaluator {
  async evaluate(
    params: EvaluationSchema,
    runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EvaluationResult> {
    const { satisfaction_threshold, indicators, measurement_method } = params as any;
    const conversationText = runResult.stdout;

    let satisfactionScore = 0;
    const method = measurement_method || 'llm_judge';

    switch (method) {
      case 'keyword_analysis':
        satisfactionScore = this.analyzeKeywords(conversationText, indicators);
        break;
      case 'sentiment_analysis':
        satisfactionScore = await this.analyzeSentiment(conversationText, runtime);
        break;
      case 'llm_judge':
      default:
        satisfactionScore = await this.judgeWithLLM(conversationText, runtime);
        break;
    }

    const threshold = satisfaction_threshold || 0.7;
    const success = satisfactionScore >= threshold;
    const percentage = (satisfactionScore * 100).toFixed(1);
    const thresholdPercentage = (threshold * 100).toFixed(1);

    const message = `User satisfaction: ${percentage}% (threshold: ${thresholdPercentage}%, method: ${method})`;

    return { success, message };
  }

  private analyzeKeywords(conversationText: string, indicators: any): number {
    const text = conversationText.toLowerCase();
    const positive = indicators?.positive || [
      'thank you',
      'thanks',
      'great',
      'perfect',
      'helpful',
      'solved',
      'fixed',
      'working',
    ];
    const negative = indicators?.negative || [
      'frustrated',
      'unhelpful',
      'confused',
      'angry',
      'useless',
      'waste of time',
    ];

    const countOccurrences = (text: string, keyword: string): number => {
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      return (text.match(regex) || []).length;
    };
    const positiveCount = positive.reduce(
      (sum: number, word: string) => sum + countOccurrences(text, word),
      0
    );
    const negativeCount = negative.reduce(
      (sum: number, word: string) => sum + countOccurrences(text, word),
      0
    );

    if (positiveCount === 0 && negativeCount === 0) return 0.5; // neutral
    return positiveCount / (positiveCount + negativeCount);
  }

  private async analyzeSentiment(conversationText: string, runtime: AgentRuntime): Promise<number> {
    const prompt = `Analyze the overall sentiment of the user in this conversation on a scale of 0.0 to 1.0, where:
- 0.0 = Very dissatisfied, angry, frustrated
- 0.5 = Neutral 
- 1.0 = Very satisfied, happy, grateful

Focus on the user's messages and their progression throughout the conversation.

Conversation:
${conversationText}

Respond with only a number between 0.0 and 1.0:`;

    try {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const score = parseFloat(response.trim());
      return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
    } catch (error) {
      console.error('[UserSatisfactionEvaluator] Sentiment analysis failed:', error);
      return 0.5; // Default to neutral on error
    }
  }

  private async judgeWithLLM(conversationText: string, runtime: AgentRuntime): Promise<number> {
    const prompt = `Evaluate how satisfied the user appears to be with this conversation on a scale of 0.0 to 1.0.

Consider:
- Did the user's problem get resolved?
- Was the user's tone positive or negative?
- Did the user express gratitude or frustration?
- Was the conversation helpful to the user?
- Did the user seem to achieve their objective?

Conversation:
${conversationText}

Respond with only a number between 0.0 and 1.0:`;

    try {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const score = parseFloat(response.trim());
      return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
    } catch (error) {
      console.error('[UserSatisfactionEvaluator] LLM judgment failed:', error);
      return 0.5; // Default to neutral on error
    }
  }
}

/**
 * Evaluates agent's ability to retain context across conversation turns
 */
export class ContextRetentionEvaluator implements Evaluator {
  async evaluate(
    params: EvaluationSchema,
    runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EvaluationResult> {
    const { test_memory_of, retention_turns, memory_accuracy_threshold } = params as any;
    const conversationText = runResult.stdout;

    const turns = this.parseConversationTurns(conversationText);
    const retentionTurns = retention_turns || 3;
    const threshold = memory_accuracy_threshold || 0.8;

    const memoryTests = [];

    for (const memoryItem of test_memory_of) {
      const accuracy = await this.testMemoryRetention(memoryItem, turns, retentionTurns, runtime);
      memoryTests.push({ item: memoryItem, accuracy });
    }

    const averageAccuracy =
      memoryTests.reduce((sum, test) => sum + test.accuracy, 0) / memoryTests.length;
    const success = averageAccuracy >= threshold;

    const itemResults = memoryTests
      .map((t) => `${t.item}: ${(t.accuracy * 100).toFixed(1)}%`)
      .join(', ');

    const message = `Context retention: ${(averageAccuracy * 100).toFixed(1)}% average (${itemResults})`;

    return { success, message };
  }

  private parseConversationTurns(conversationText: string): string[] {
    const turns = conversationText.split(/Turn \d+:/).filter((turn) => turn.trim());
    return turns;
  }

  private async testMemoryRetention(
    memoryItem: string,
    turns: string[],
    retentionTurns: number,
    runtime: AgentRuntime
  ): Promise<number> {
    // Find where the memory item is first mentioned
    let mentionTurn = -1;
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].toLowerCase().includes(memoryItem.toLowerCase())) {
        mentionTurn = i;
        break;
      }
    }

    if (mentionTurn === -1) return 0; // Item never mentioned

    // Check retention in subsequent turns
    let retentionScore = 0;
    let testsCount = 0;

    const endTurn = Math.min(turns.length, mentionTurn + retentionTurns + 1);
    for (let i = mentionTurn + 1; i < endTurn; i++) {
      const retained = await this.checkMemoryInTurn(
        memoryItem,
        turns[i],
        turns.slice(0, i + 1),
        runtime
      );
      if (retained) retentionScore += 1;
      testsCount += 1;
    }

    return testsCount > 0 ? retentionScore / testsCount : 0;
  }

  private async checkMemoryInTurn(
    memoryItem: string,
    currentTurn: string,
    previousTurns: string[],
    runtime: AgentRuntime
  ): Promise<boolean> {
    const context = previousTurns.slice(0, -1).join('\n'); // All turns except current

    const prompt = `Based on the previous conversation context, does the agent demonstrate memory/awareness of "${memoryItem}" in the current turn?

Previous context:
${context}

Current turn:
${currentTurn}

The agent shows memory if they:
- Reference the specific item
- Use information related to the item
- Show understanding of previous mentions

Respond with only 'yes' or 'no'.`;

    try {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      return response.toLowerCase().includes('yes');
    } catch (error) {
      console.error(`[ContextRetentionEvaluator] Memory check failed for ${memoryItem}:`, error);
      return false;
    }
  }
}
