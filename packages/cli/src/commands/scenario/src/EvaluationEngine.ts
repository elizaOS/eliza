import { AgentRuntime, ModelType } from '@elizaos/core';
import { ExecutionResult } from './providers';
import { Evaluation as EvaluationSchema } from './schema';
import { z } from 'zod';
import type { ObjectGenerationParams } from '@elizaos/core';
import {
  ConversationLengthEvaluator,
  ConversationFlowEvaluator,
  UserSatisfactionEvaluator,
  ContextRetentionEvaluator,
} from './ConversationEvaluators';

export interface EvaluationResult {
  success: boolean;
  message: string;
}

export interface Evaluator {
  evaluate(
    params: EvaluationSchema,
    runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EvaluationResult>;
}

export class EvaluationEngine {
  private evaluators = new Map<string, Evaluator>();

  constructor(private runtime: AgentRuntime) {
    // Register all known evaluators
    this.register('string_contains', new StringContainsEvaluator());
    this.register('regex_match', new RegexMatchEvaluator());
    this.register('file_exists', new FileExistsEvaluator());
    this.register('trajectory_contains_action', new TrajectoryContainsActionEvaluator());
    this.register('llm_judge', new LLMJudgeEvaluator());
    this.register('execution_time', new ExecutionTimeEvaluator());

    // NEW: Register conversation evaluators
    this.register('conversation_length', new ConversationLengthEvaluator());
    this.register('conversation_flow', new ConversationFlowEvaluator());
    this.register('user_satisfaction', new UserSatisfactionEvaluator());
    this.register('context_retention', new ContextRetentionEvaluator());
  }

  private register(type: string, evaluator: Evaluator) {
    this.evaluators.set(type, evaluator);
  }

  public async runEvaluations(
    evaluations: EvaluationSchema[],
    runResult: ExecutionResult
  ): Promise<EvaluationResult[]> {
    const results: EvaluationResult[] = [];

    for (const evaluation of evaluations) {
      const evaluator = this.evaluators.get(evaluation.type);
      if (!evaluator) {
        results.push({
          success: false,
          message: `Unknown evaluator type: '${evaluation.type}'`,
        });
        continue;
      }

      const result = await evaluator.evaluate(evaluation, runResult, this.runtime);
      results.push(result);
    }

    return results;
  }

  /**
   * NEW: Enhanced evaluation method for ticket #5783
   * Returns structured JSON output using the enhanced evaluation engine
   */
  public async runEnhancedEvaluations(
    evaluations: EvaluationSchema[],
    runResult: ExecutionResult
  ): Promise<import('./schema').EnhancedEvaluationResult[]> {
    // Use enhanced evaluation engine directly
    const { EnhancedEvaluationEngine } = await import('./EnhancedEvaluationEngine');
    const enhancedEngine = new EnhancedEvaluationEngine(this.runtime);
    return enhancedEngine.runEnhancedEvaluations(evaluations, runResult);
  }
}

// --- IMPLEMENTATIONS ---

class StringContainsEvaluator implements Evaluator {
  async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
    if (params.type !== 'string_contains')
      throw new Error(
        `Mismatched evaluator: expected 'string_contains', received '${params.type}'`
      );

    const success = runResult.stdout.includes(params.value);
    return {
      success,
      message: `Checked if stdout contains "${params.value}". Result: ${success}`,
    };
  }
}

class RegexMatchEvaluator implements Evaluator {
  async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
    if (params.type !== 'regex_match')
      throw new Error(`Mismatched evaluator: expected 'regex_match', received '${params.type}'`);

    const success = new RegExp(params.pattern, 'i').test(runResult.stdout);
    return {
      success,
      message: `Checked if stdout matches regex "${params.pattern}". Result: ${success}`,
    };
  }
}

class FileExistsEvaluator implements Evaluator {
  async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
    if (params.type !== 'file_exists')
      throw new Error(`Mismatched evaluator: expected 'file_exists', received '${params.type}'`);

    // Check for both exact path and relative path (with ./ prefix)
    const filePaths = Object.keys(runResult.files);
    const success =
      filePaths.includes(params.path) ||
      filePaths.includes(`./${params.path}`) ||
      filePaths.includes(params.path.replace(/^\.\//, ''));

    return {
      success,
      message: `Checked if file "${params.path}" exists. Result: ${success}`,
    };
  }
}

class ExecutionTimeEvaluator implements Evaluator {
  async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
    if (params.type !== 'execution_time')
      throw new Error(`Mismatched evaluator: expected 'execution_time', received '${params.type}'`);

    const duration =
      runResult.durationMs ?? (runResult.endedAtMs ?? 0) - (runResult.startedAtMs ?? 0);
    if (duration == null || Number.isNaN(duration)) {
      return {
        success: false,
        message: 'No timing information available for this step',
      };
    }

    const tooSlow = duration > params.max_duration_ms;
    const tooFast = params.min_duration_ms != null && duration < params.min_duration_ms;
    const success = !tooSlow && !tooFast;

    return {
      success,
      message: `Execution time ${duration}ms (min=${params.min_duration_ms ?? '-'}, target=${params.target_duration_ms ?? '-'}, max=${params.max_duration_ms})`,
    };
  }
}

export class TrajectoryContainsActionEvaluator implements Evaluator {
  async evaluate(
    params: EvaluationSchema,
    _runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EvaluationResult> {
    if (params.type !== 'trajectory_contains_action')
      throw new Error(
        `Mismatched evaluator: expected 'trajectory_contains_action', received '${params.type}'`
      );

    const actionName = params.action;

    try {
      // Wait for action memories to be written to database (prevents race condition)
      console.log(
        `🔧 [TrajectoryContainsActionEvaluator] Waiting 2s for action memories to be written...`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get action memories from database
      const actionMemories = await runtime.getMemories({
        tableName: 'messages',
        agentId: runtime.agentId,
        count: 50, // Get recent actions
        unique: false,
      });

      // Filter for action_result memories - look for both content.type and metadata.type
      const actionResults = actionMemories.filter((mem) => {
        if (!mem || typeof mem.content !== 'object') return false;

        const contentType = mem.content?.type;
        const metadataType = mem.metadata?.type;
        const hasActionName = (mem.content as any)?.actionName || (mem.metadata as any)?.actionName;

        return (
          contentType === 'action_result' ||
          metadataType === 'action_result' ||
          (contentType === 'agent' && hasActionName) // Also check agent messages with action names
        );
      });

      // Normalize function to compare action names robustly (case/underscore insensitive)
      const normalize = (name: string | undefined): string =>
        (typeof name === 'string' ? name : '').toLowerCase().replace(/_/g, '');
      const target = normalize(actionName);

      // Check if any action matches the specified name (normalized) - check both content and metadata
      const matchingAction = actionResults.find((mem) => {
        const contentActionName = (mem.content as any)?.actionName;
        const metadataActionName = (mem.metadata as any)?.actionName;
        const contentNormalized = normalize(contentActionName);
        const metadataNormalized = normalize(metadataActionName);

        return contentNormalized === target || metadataNormalized === target;
      });

      if (!matchingAction) {
        return {
          success: false,
          message: `Action '${actionName}' was not found in the execution trajectory`,
        };
      }

      const actionStatus = (matchingAction.content as any)?.actionStatus || 'unknown';
      const message =
        actionStatus === 'completed'
          ? `Action '${params.action}' was executed successfully`
          : `Action '${params.action}' was executed but failed: ${(matchingAction.content as any)?.error || 'Unknown error'}`;

      return {
        success: true, // Success means the action was found
        message,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to check action trajectory: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

class LLMJudgeEvaluator implements Evaluator {
  async evaluate(
    params: EvaluationSchema,
    runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EvaluationResult> {
    if (params.type !== 'llm_judge')
      throw new Error(`Mismatched evaluator: expected 'llm_judge', received '${params.type}'`);

    const prompt = params.prompt;
    const expected = params.expected;
    // Try OBJECT_SMALL first, then TEXT_LARGE/TEXT_SMALL
    const candidateModels = [ModelType.OBJECT_SMALL, ModelType.TEXT_LARGE, ModelType.TEXT_SMALL];
    const temperature = params.temperature || 0.1;
    const jsonSchema = (params.json_schema as any) || this.getDefaultJudgmentSchema();
    const timeoutMs = Number(process.env.LLM_JUDGE_TIMEOUT_MS || 15000);

    // Pick first available model
    let modelType = ModelType.TEXT_LARGE;

    // Create a simple, clear prompt for object generation
    const fullPrompt = `
Context: A program was executed with the following results:
- Exit Code: ${runResult.exitCode}
- Standard Output: ${runResult.stdout}
- Standard Error: ${runResult.stderr}
- Files Created: ${Object.keys(runResult.files).join(', ')}

Question: ${prompt}

Expected: ${expected}

CRITICAL: You must respond with a JSON object that EXACTLY matches this schema:
${JSON.stringify(jsonSchema, null, 2)}

The response MUST include these exact field names:
${Object.keys(jsonSchema.properties).join(', ')}

Do not use any other field names. Use only the exact field names specified above.`;

    try {
      // Check if the picked model is available; if not, return gracefully
      const availableModels = (runtime as any).models; // unused
      const modelKeys =
        availableModels && typeof availableModels.keys === 'function'
          ? Array.from(availableModels.keys())
          : Object.keys(availableModels || {});
      console.log(`🔍 [LLMJudgeEvaluator] Available models: ${JSON.stringify(availableModels)}`);
      console.log(`🔍 [LLMJudgeEvaluator] Model keys: ${JSON.stringify(modelKeys)}`);
      const modelHandler = runtime.getModel(modelType);
      console.log(`🔍 [LLMJudgeEvaluator] Model handler: ${JSON.stringify(modelHandler)}`);
      console.log(`🔍 [LLMJudgeEvaluator] Model type: ${modelType}`);
      console.log(`🔍 [LLMJudgeEvaluator] Candidate models: ${candidateModels.join(', ')}`);
      if (!modelHandler) {
        return {
          success: false,
          message: `LLM judge: no available model handler (tried ${candidateModels.join(', ')})`,
        };
      }

      // Check if OpenAI plugin is loaded
      // const openaiService = runtime.getService('openai');

      // Check all loaded services
      // const allServices = (runtime as any).services;

      // Do not include runtime here; runtime.useModel will inject it
      const objectParams: Omit<ObjectGenerationParams, 'runtime'> = {
        prompt: fullPrompt,
        schema: jsonSchema,
        temperature,
        output: 'object',
      } as any;

      const response = await Promise.race([
        runtime.useModel(modelType, objectParams),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`LLM judge timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);

      // The object model should return a proper object, but let's validate it
      const parsedResponse = this.validateResponse(response, jsonSchema);

      // Compare with expected result
      const success = this.compareWithExpected(parsedResponse, expected);

      return {
        success,
        message: `LLM judgment: ${(parsedResponse as any).judgment} (confidence: ${(parsedResponse as any).confidence}). Expected: "${expected}". Result: ${success}`,
      };
    } catch (error: any) {
      const msg = error?.message || String(error);
      const isTimeout = msg.toLowerCase().includes('timeout');
      return {
        success: false,
        message: isTimeout ? `LLM judge timed out after ${timeoutMs}ms` : `LLM judge error: ${msg}`,
      };
    }
  }

  private getDefaultJudgmentSchema() {
    return {
      type: 'object',
      properties: {
        judgment: { type: 'string', enum: ['yes', 'no'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasoning: { type: 'string' },
      },
      required: ['judgment', 'confidence', 'reasoning'],
    };
  }

  private validateResponse(response: unknown, schema: z.ZodSchema): unknown {
    // The object model should return a proper object, but let's validate it
    if (typeof response === 'string') {
      // Fallback: parse as JSON if it's a string
      const parsed = JSON.parse(response);
      return this.validateWithZod(parsed, schema);
    }

    // If it's already an object, validate it directly
    return this.validateWithZod(response, schema);
  }

  private validateWithZod(response: unknown, schema: z.ZodSchema): unknown {
    try {
      const zodSchema = this.convertToZodSchema(schema);
      return zodSchema.parse(response);
    } catch (error) {
      throw error;
    }
  }

  private convertToZodSchema(schema: any): z.ZodObject<any> {
    // Convert JSON schema to Zod schema
    const properties: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(schema.properties || {})) {
      const propSchema = prop as any;

      if (propSchema.type === 'string') {
        let zodProp: z.ZodTypeAny = z.string();
        if (propSchema.enum) {
          zodProp = z.enum(propSchema.enum as [string, ...string[]]);
        }
        properties[key] = zodProp;
      } else if (propSchema.type === 'number') {
        let zodProp = z.number();
        if (propSchema.minimum !== undefined) {
          zodProp = zodProp.min(propSchema.minimum);
        }
        if (propSchema.maximum !== undefined) {
          zodProp = zodProp.max(propSchema.maximum);
        }
        properties[key] = zodProp;
      } else if (propSchema.type === 'boolean') {
        properties[key] = z.boolean();
      }
    }

    return z.object(properties);
  }

  private compareWithExpected(parsedResponse: any, expected: string): boolean {
    const judgment = parsedResponse.judgment.toLowerCase();
    const expectedLower = expected.toLowerCase();

    // Handle yes/no expectations
    if (expectedLower === 'yes' || expectedLower === 'no') {
      return judgment === expectedLower;
    }

    // Handle confidence thresholds (e.g., "0.8+")
    if (expectedLower.includes('+')) {
      const threshold = parseFloat(expectedLower.replace('+', ''));
      return parsedResponse.confidence >= threshold;
    }

    // Handle confidence upper bounds (e.g., "0.3-")
    if (expectedLower.endsWith('-')) {
      const threshold = parseFloat(expectedLower.replace('-', ''));
      return parsedResponse.confidence <= threshold;
    }

    // Handle confidence ranges (e.g., "0.8-1.0")
    if (expectedLower.includes('-')) {
      const [min, max] = expectedLower.split('-').map(Number);
      return parsedResponse.confidence >= min && parsedResponse.confidence <= max;
    }

    // Default: check if judgment contains expected
    return judgment.includes(expectedLower);
  }
}
