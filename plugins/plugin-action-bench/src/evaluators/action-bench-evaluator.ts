import { IAgentRuntime, ModelType, parseKeyValueXml } from '@elizaos/core';
import { TestStep, StepResult, ActionEvaluationConfig, ResponseEvaluationConfig } from '../types/action-bench-types';

export class ActionBenchEvaluator {
  private collectedActions: string[] = [];
  
  constructor(private runtime: IAgentRuntime) {}

  async evaluateStep(
    step: TestStep, 
    agentResponse: string, 
    finalActions: string[] = []
  ): Promise<StepResult> {
    // Add any final actions to collected actions
    if (finalActions.length > 0) {
      this.collectedActions.push(...finalActions);
    }
    
    // Evaluate actions
    const actionEvaluation = this.evaluateActions(
      step.expectedActions, 
      this.collectedActions, 
      step.actionEvaluation
    );
    
    // Evaluate response if needed
    let responseEvaluation;
    if (step.responseEvaluation.enabled) {
      responseEvaluation = await this.evaluateResponseWithLLM(
        agentResponse, 
        step.responseEvaluation
      );
    }

    return {
      stepId: step.stepId,
      passed: actionEvaluation.passed && (responseEvaluation?.passed !== false),
      collectedActions: [...this.collectedActions],
      agentResponse,
      actionEvaluation,
      responseEvaluation
    };
  }

  addActions(actions: string[]): void {
    this.collectedActions.push(...actions);
    console.log('📋 Actions added to collection:', actions);
    console.log('📊 Total collected actions:', this.collectedActions);
  }

  private evaluateActions(
    expectedActions: string[], 
    collectedActions: string[], 
    config: ActionEvaluationConfig
  ): { passed: boolean; details: string } {
    if (config.requiresOrder) {
      // Check if expected actions appear in order within collected actions
      let expectedIndex = 0;
      let foundSequence: string[] = [];
      
      for (const action of collectedActions) {
        if (expectedIndex < expectedActions.length && action === expectedActions[expectedIndex]) {
          foundSequence.push(action);
          expectedIndex++;
        }
      }
      
      const passed = expectedIndex === expectedActions.length;
      return {
        passed,
        details: passed 
          ? `✅ Found expected sequence: [${foundSequence.join(', ')}]`
          : `❌ Expected sequence [${expectedActions.join(', ')}], but found [${foundSequence.join(', ')}] (missing ${expectedActions.length - expectedIndex} actions)`
      };
    } else {
      // Check if all expected actions are present (order doesn't matter)
      const missingActions = expectedActions.filter(action => !collectedActions.includes(action));
      const passed = missingActions.length === 0;
      
      return {
        passed,
        details: passed
          ? `✅ Found all expected actions: [${expectedActions.join(', ')}]`
          : `❌ Missing actions: [${missingActions.join(', ')}]`
      };
    }
  }

  private async evaluateResponseWithLLM(
    response: string, 
    config: ResponseEvaluationConfig
  ): Promise<{ passed: boolean; score: number; reasoning: string }> {
    try {
      const evaluationPrompt = `
# Task: Evaluate Agent Response Quality

## Response to Evaluate:
"${response}"

## Evaluation Criteria:
${config.criteria}

## Instructions:
1. Carefully read the agent's response
2. Evaluate it against the specified criteria
3. Provide a score from 0-10 (10 = perfect, 0 = completely wrong)
4. Explain your reasoning

IMPORTANT: Respond ONLY with XML in this exact format:
<response>
<score>7</score>
<passed>true</passed>
<reasoning>The response meets the criteria because...</reasoning>
</response>
`;

      const result = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: evaluationPrompt,
        temperature: 0.1
      });

      const parsed = parseKeyValueXml(result);
      if (!parsed) {
        throw new Error('Failed to parse LLM evaluation response');
      }

      const score = parseInt(parsed.score || '0');
      const passed = parsed.passed === 'true' || score >= 7;
      const reasoning = parsed.reasoning || 'No reasoning provided';

      return { passed, score, reasoning };
    } catch (error) {
      console.error('Error evaluating response with LLM:', error);
      return {
        passed: false,
        score: 0,
        reasoning: `LLM evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  reset(): void {
    this.collectedActions = [];
  }

  getCollectedActions(): string[] {
    return [...this.collectedActions];
  }
}
