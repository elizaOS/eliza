/**
 * Enhanced Evaluation Engine for Ticket #5783
 *
 * This module provides structured JSON output from evaluators while maintaining
 * 100% backward compatibility with existing scenario files.
 *
 * CRITICAL: This is an ADDITIVE enhancement that does NOT break existing functionality.
 */

import { AgentRuntime, ModelType } from '@elizaos/core';
import { ExecutionResult } from './providers';
import { Evaluation as EvaluationSchema, EnhancedEvaluationResult } from './schema';
import { Evaluator } from './EvaluationEngine'; // Import existing types
import { z } from 'zod';
import type { ObjectGenerationParams } from '@elizaos/core';

/**
 * Enhanced evaluator interface that returns structured results
 */
export interface EnhancedEvaluator {
  evaluateEnhanced(
    params: EvaluationSchema,
    runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EnhancedEvaluationResult>;
}

/**
 * Adapter that can work with both legacy and enhanced evaluators
 */
export interface DualEvaluator extends Evaluator, EnhancedEvaluator {}

/**
 * Enhanced Evaluation Engine that provides structured JSON output
 * while maintaining backward compatibility with existing scenarios.
 */
export class EnhancedEvaluationEngine {
  private enhancedEvaluators = new Map<string, EnhancedEvaluator>();

  constructor(private runtime: AgentRuntime) {
    // Register enhanced versions of all evaluators
    this.register('string_contains', new EnhancedStringContainsEvaluator());
    this.register('regex_match', new EnhancedRegexMatchEvaluator());
    this.register('file_exists', new EnhancedFileExistsEvaluator());
    this.register('trajectory_contains_action', new EnhancedTrajectoryContainsActionEvaluator());
    this.register('llm_judge', new EnhancedLLMJudgeEvaluator());
    this.register('execution_time', new EnhancedExecutionTimeEvaluator());
  }

  private register(type: string, evaluator: EnhancedEvaluator) {
    this.enhancedEvaluators.set(type, evaluator);
  }

  /**
   * NEW: Run evaluations with structured JSON output
   */
  public async runEnhancedEvaluations(
    evaluations: EvaluationSchema[],
    runResult: ExecutionResult
  ): Promise<EnhancedEvaluationResult[]> {
    const results: EnhancedEvaluationResult[] = [];

    for (const evaluation of evaluations) {
      const evaluator = this.enhancedEvaluators.get(evaluation.type);
      if (!evaluator) {
        results.push({
          evaluator_type: evaluation.type,
          success: false,
          summary: `Unknown evaluator type: '${evaluation.type}'`,
          details: {
            error: 'evaluator_not_found',
            requested_type: evaluation.type,
            available_types: Array.from(this.enhancedEvaluators.keys()),
          },
        });
        continue;
      }

      try {
        const result = await evaluator.evaluateEnhanced(evaluation, runResult, this.runtime);
        results.push(result);
      } catch (error) {
        results.push({
          evaluator_type: evaluation.type,
          success: false,
          summary: `Evaluator '${evaluation.type}' failed with error: ${error instanceof Error ? error.message : String(error)}`,
          details: {
            error: 'evaluator_execution_failed',
            error_message: error instanceof Error ? error.message : String(error),
            evaluation_config: evaluation,
          },
        });
      }
    }

    return results;
  }
}

// --- ENHANCED EVALUATOR IMPLEMENTATIONS ---

class EnhancedStringContainsEvaluator implements EnhancedEvaluator {
  async evaluateEnhanced(
    params: EvaluationSchema,
    runResult: ExecutionResult
  ): Promise<EnhancedEvaluationResult> {
    if (params.type !== 'string_contains') throw new Error('Mismatched evaluator');

    const expectedValue = params.value;
    const actualOutput = runResult.stdout;
    const caseSensitive = params.case_sensitive ?? false;

    const searchIn = caseSensitive ? actualOutput : actualOutput.toLowerCase();
    const searchFor = caseSensitive ? expectedValue : expectedValue.toLowerCase();
    const success = searchIn.includes(searchFor);

    return {
      evaluator_type: 'string_contains',
      success,
      summary: success
        ? `Assertion PASSED: Agent response contained the expected substring "${expectedValue}".`
        : `Assertion FAILED: Agent response did not contain the expected substring "${expectedValue}".`,
      details: {
        expected_value: expectedValue,
        actual_output: actualOutput,
        case_sensitive: caseSensitive,
        search_performed: `Looking for "${searchFor}" in "${searchIn.substring(0, 100)}${searchIn.length > 100 ? '...' : ''}"`,
      },
    };
  }
}

class EnhancedRegexMatchEvaluator implements EnhancedEvaluator {
  async evaluateEnhanced(
    params: EvaluationSchema,
    runResult: ExecutionResult
  ): Promise<EnhancedEvaluationResult> {
    if (params.type !== 'regex_match') throw new Error('Mismatched evaluator');

    const pattern = params.pattern;
    const actualOutput = runResult.stdout;
    const regex = new RegExp(pattern, 'i');
    const match = regex.exec(actualOutput);
    const success = match !== null;

    return {
      evaluator_type: 'regex_match',
      success,
      summary: success
        ? `Regex PASSED: Pattern "${pattern}" matched in agent output.`
        : `Regex FAILED: Pattern "${pattern}" did not match in agent output.`,
      details: {
        pattern,
        regex_flags: 'i',
        actual_output: actualOutput,
        match_found: match,
        match_index: match?.index,
        matched_text: match?.[0],
      },
    };
  }
}

class EnhancedFileExistsEvaluator implements EnhancedEvaluator {
  async evaluateEnhanced(
    params: EvaluationSchema,
    runResult: ExecutionResult
  ): Promise<EnhancedEvaluationResult> {
    if (params.type !== 'file_exists') throw new Error('Mismatched evaluator');

    const expectedPath = params.path;
    const createdFiles = Object.keys(runResult.files);

    // Check for both exact path and relative path variations
    const success =
      createdFiles.includes(expectedPath) ||
      createdFiles.includes(`./${expectedPath}`) ||
      createdFiles.includes(expectedPath.replace(/^\.\//, ''));

    const matchingPath = createdFiles.find(
      (path) =>
        path === expectedPath ||
        path === `./${expectedPath}` ||
        path === expectedPath.replace(/^\.\//, '')
    );

    return {
      evaluator_type: 'file_exists',
      success,
      summary: success
        ? `File check PASSED: File "${expectedPath}" was created by the agent.`
        : `File check FAILED: File "${expectedPath}" was not created by the agent.`,
      details: {
        expected_path: expectedPath,
        created_files: createdFiles,
        matching_path: matchingPath,
        total_files_created: createdFiles.length,
      },
    };
  }
}

class EnhancedExecutionTimeEvaluator implements EnhancedEvaluator {
  async evaluateEnhanced(
    params: EvaluationSchema,
    runResult: ExecutionResult
  ): Promise<EnhancedEvaluationResult> {
    if (params.type !== 'execution_time') throw new Error('Mismatched evaluator');

    const duration =
      runResult.durationMs ?? (runResult.endedAtMs ?? 0) - (runResult.startedAtMs ?? 0);

    if (
      duration == null ||
      Number.isNaN(duration) ||
      (runResult.durationMs === undefined &&
        (runResult.startedAtMs === undefined || runResult.endedAtMs === undefined))
    ) {
      return {
        evaluator_type: 'execution_time',
        success: false,
        summary: 'Timing check FAILED: No timing information available for this step.',
        details: {
          error: 'no_timing_data',
          runResult_timing: {
            durationMs: runResult.durationMs,
            startedAtMs: runResult.startedAtMs,
            endedAtMs: runResult.endedAtMs,
          },
          constraints: params,
        },
      };
    }

    const tooSlow = duration > params.max_duration_ms;
    const tooFast = params.min_duration_ms != null && duration < params.min_duration_ms;
    const success = !tooSlow && !tooFast;

    let summary: string;
    if (success) {
      summary = `Timing check PASSED: Execution took ${duration}ms (within expected range).`;
    } else if (tooSlow) {
      summary = `Timing check FAILED: Execution took ${duration}ms (exceeded maximum of ${params.max_duration_ms}ms).`;
    } else {
      summary = `Timing check FAILED: Execution took ${duration}ms (below minimum of ${params.min_duration_ms}ms).`;
    }

    return {
      evaluator_type: 'execution_time',
      success,
      summary,
      details: {
        actual_duration_ms: duration,
        max_duration_ms: params.max_duration_ms,
        min_duration_ms: params.min_duration_ms,
        target_duration_ms: params.target_duration_ms,
        performance_rating: params.target_duration_ms
          ? Math.abs(duration - params.target_duration_ms) / params.target_duration_ms
          : null,
        timing_breakdown: {
          started_at: runResult.startedAtMs,
          ended_at: runResult.endedAtMs,
          calculated_duration: runResult.durationMs,
        },
      },
    };
  }
}

class EnhancedTrajectoryContainsActionEvaluator implements EnhancedEvaluator {
  async evaluateEnhanced(
    params: EvaluationSchema,
    _runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EnhancedEvaluationResult> {
    if (params.type !== 'trajectory_contains_action') throw new Error('Mismatched evaluator');

    const actionName = params.action;

    try {
      // Wait for action memories to be written to database (prevents race condition)
      console.log(
        `🔧 [EnhancedTrajectoryContainsActionEvaluator] Waiting 2s for action memories to be written...`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get action memories from database
      const actionMemories = await runtime.getMemories({
        tableName: 'messages',
        agentId: runtime.agentId,
        count: 50,
        unique: false,
      });

      // Filter for action_result memories
      const actionResults = actionMemories.filter((mem) => mem.content?.type === 'action_result');

      // Normalize function to compare action names robustly
      const normalize = (name: string | undefined): string =>
        (typeof name === 'string' ? name : '').toLowerCase().replace(/_/g, '');
      const target = normalize(actionName);

      // Find matching action
      const matchingAction = actionResults.find(
        (mem) => normalize((mem.content as any)?.actionName ?? '') === target
      );

      const allActionNames = actionResults.map(
        (mem) => (mem.content as any)?.actionName || 'unknown'
      );

      if (!matchingAction) {
        return {
          evaluator_type: 'trajectory_contains_action',
          success: false,
          summary: `Action check FAILED: Action '${actionName}' was not found in the execution trajectory.`,
          details: {
            expected_action: actionName,
            normalized_expected: target,
            actions_found: allActionNames,
            total_actions_in_trajectory: actionResults.length,
            search_method: 'case_insensitive_with_underscore_normalization',
          },
        };
      }

      const actionStatus = matchingAction.content?.actionStatus || 'unknown';
      const actionSucceeded = actionStatus === 'completed';

      return {
        evaluator_type: 'trajectory_contains_action',
        success: true, // Success means the action was found (regardless of its outcome)
        summary: actionSucceeded
          ? `Action check PASSED: Action '${actionName}' was executed successfully.`
          : `Action check PASSED: Action '${actionName}' was found but failed execution.`,
        details: {
          expected_action: actionName,
          found_action: matchingAction.content?.actionName,
          action_status: actionStatus,
          action_succeeded: actionSucceeded,
          action_error: matchingAction.content?.error,
          action_result: matchingAction.content?.result,
          memory_id: matchingAction.id,
          all_actions_in_trajectory: allActionNames,
        },
      };
    } catch (error) {
      return {
        evaluator_type: 'trajectory_contains_action',
        success: false,
        summary: `Action check FAILED: Error while checking trajectory: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          expected_action: actionName,
          error: 'trajectory_access_failed',
          error_message: error instanceof Error ? error.message : String(error),
          runtime_available: !!runtime,
          agent_id: runtime?.agentId,
        },
      };
    }
  }
}

class EnhancedLLMJudgeEvaluator implements EnhancedEvaluator {
  async evaluateEnhanced(
    params: EvaluationSchema,
    runResult: ExecutionResult,
    runtime: AgentRuntime
  ): Promise<EnhancedEvaluationResult> {
    if (params.type !== 'llm_judge') throw new Error('Mismatched evaluator');

    const prompt = params.prompt;
    const expected = params.expected;
    const candidateModels = [ModelType.OBJECT_SMALL, ModelType.TEXT_LARGE, ModelType.TEXT_SMALL];
    const temperature = params.temperature || 0.1;
    const timeoutMs = Number(process.env.LLM_JUDGE_TIMEOUT_MS || 15000);

    // Pick first available model
    let modelType: (typeof ModelType)[keyof typeof ModelType] =
      candidateModels.find((m) => runtime.getModel?.(m)) ?? ModelType.TEXT_LARGE;

    // Enhanced structured prompt for qualitative analysis with dynamic capabilities
    const capabilities = (params as any).capabilities; // Extract capabilities from params

    // Validate capabilities if provided - use schema validation for proper error messages
    if (capabilities !== undefined) {
      try {
        // Validate just the capabilities array using schema validation
        const capabilitiesSchema = z
          .array(z.string())
          .min(1, 'Capabilities array must not be empty');
        capabilitiesSchema.parse(capabilities);
      } catch (error: any) {
        throw new Error(`Invalid capabilities: ${error.message}`);
      }
    }

    const structuredPrompt = this.createStructuredPrompt(runResult, prompt, expected, capabilities);
    const jsonSchema = this.getStructuredJudgmentSchema();

    try {
      const modelHandler = runtime.getModel(modelType);
      if (!modelHandler) {
        return {
          evaluator_type: 'llm_judge',
          success: false,
          summary: `LLM Judge FAILED: No available model handler found.`,
          details: {
            error: 'no_model_available',
            attempted_models: candidateModels,
            models_available: Array.from(runtime.models.keys()),
            prompt,
            expected,
          },
        };
      }

      const objectParams: Omit<ObjectGenerationParams, 'runtime'> = {
        prompt: structuredPrompt,
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

      // Parse and validate the structured response
      let parsedResponse;
      try {
        parsedResponse = this.validateStructuredResponse(response, jsonSchema);
      } catch (parseError: any) {
        return {
          evaluator_type: 'llm_judge',
          success: false,
          summary: `LLM Judge FAILED: Invalid LLM response - ${parseError.message}`,
          details: {
            error: 'llm_parse_error',
            error_type: 'llm_parse_error',
            error_message: parseError.message,
            model_used: modelType,
            prompt,
            expected,
            raw_llm_response: response,
            custom_capabilities_provided: !!(capabilities && capabilities.length > 0),
            capabilities_count: capabilities ? capabilities.length : 0,
          },
        };
      }
      const success = this.compareWithExpected(parsedResponse, expected);

      return {
        evaluator_type: 'llm_judge',
        success,
        summary: `LLM Judge ${success ? 'PASSED' : 'FAILED'}: ${parsedResponse.qualitative_summary.substring(0, 150)}${parsedResponse.qualitative_summary.length > 150 ? '...' : ''}`,
        details: {
          llm_judge_result: {
            qualitative_summary: parsedResponse.qualitative_summary,
            capability_checklist: parsedResponse.capability_checklist,
          },
          custom_capabilities_provided: !!(capabilities && capabilities.length > 0),
          capabilities_count: capabilities ? capabilities.length : 5, // Default capabilities count
          judgment_confidence: parsedResponse.confidence,
          expected_outcome: expected,
          model_used: modelType,
          prompt_used: prompt,
          raw_llm_response: response,
        },
      };
    } catch (error: any) {
      const msg = error?.message || String(error);
      const isTimeout = msg.toLowerCase().includes('timeout');

      return {
        evaluator_type: 'llm_judge',
        success: false,
        summary: isTimeout
          ? `LLM Judge FAILED: Timed out after ${timeoutMs}ms.`
          : `LLM Judge FAILED: ${msg}`,
        details: {
          error: isTimeout ? 'llm_timeout' : 'llm_error',
          error_type: isTimeout ? 'llm_timeout' : 'llm_error',
          error_message: msg,
          timeout_ms: timeoutMs,
          model_attempted: modelType,
          prompt,
          expected,
          custom_capabilities_provided: !!(capabilities && capabilities.length > 0),
          capabilities_count: capabilities ? capabilities.length : 0,
        },
      };
    }
  }

  private createStructuredPrompt(
    runResult: ExecutionResult,
    userPrompt: string,
    expected: string,
    capabilities?: string[]
  ): string {
    // Default capabilities if none provided
    const defaultCapabilities = [
      'Task Completion',
      'Response Quality',
      'User Intent Understanding',
      'Error Handling',
      'Appropriate Response Format',
    ];

    const capabilitiesToUse =
      capabilities && capabilities.length > 0 ? capabilities : defaultCapabilities;

    // Build capabilities list for prompt
    const capabilitiesSection = capabilitiesToUse
      .map((capability, index) => {
        return `${index + 1}. ${capability}`;
      })
      .join('\n');

    return `You are an expert evaluator analyzing an AI agent's performance. Provide a comprehensive, structured assessment.

## Execution Context
- Exit Code: ${runResult.exitCode}
- Standard Output: ${runResult.stdout}
- Standard Error: ${runResult.stderr}  
- Files Created: ${Object.keys(runResult.files).join(', ') || 'None'}

## Evaluation Question
${userPrompt}

## Expected Outcome
${expected}

## Instructions
Analyze the agent's performance and provide a detailed assessment. You must evaluate the agent against the following specific capabilities:

${capabilitiesSection}

For each capability listed above, you must assess whether the agent achieved it and provide detailed reasoning. Your response should include:

1. **Qualitative Summary**: A comprehensive paragraph summarizing overall performance
2. **Capability Checklist**: For each capability above, provide:
   - capability: The exact capability name from the list
   - achieved: Boolean indicating if the capability was demonstrated
   - reasoning: Detailed explanation of your assessment

Provide your assessment as a structured JSON response with detailed reasoning for each capability.`;
  }

  private getStructuredJudgmentSchema() {
    return {
      type: 'object',
      properties: {
        qualitative_summary: {
          type: 'string',
          description:
            "A comprehensive paragraph summarizing the agent's performance, reasoning, and notable successes or failures",
        },
        capability_checklist: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              capability: { type: 'string' },
              achieved: { type: 'boolean' },
              reasoning: { type: 'string' },
            },
            required: ['capability', 'achieved', 'reasoning'],
          },
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence level in the assessment (0-1)',
        },
        overall_success: {
          type: 'boolean',
          description: 'Whether the agent successfully met the expected outcome',
        },
      },
      required: ['qualitative_summary', 'capability_checklist', 'confidence', 'overall_success'],
    };
  }

  private validateStructuredResponse(response: any, _schema: any): any {
    if (typeof response === 'string') {
      response = JSON.parse(response);
    }

    // Validate required fields
    if (!response.qualitative_summary || !response.capability_checklist) {
      throw new Error('Invalid LLM response: missing required fields');
    }

    // Ensure capability_checklist is properly formatted
    if (!Array.isArray(response.capability_checklist)) {
      throw new Error('Invalid LLM response: capability_checklist must be an array');
    }

    // Add default capabilities if none provided
    if (response.capability_checklist.length === 0) {
      response.capability_checklist = [
        {
          capability: 'Task Completion',
          achieved: response.overall_success || false,
          reasoning: 'Default capability assessment based on overall success',
        },
      ];
    }

    // Provide default values for missing fields
    if (response.confidence === undefined) {
      response.confidence = 0.8; // Default confidence
    }

    if (response.overall_success === undefined) {
      // Determine overall success based on capability checklist
      const allAchieved = response.capability_checklist.every((cap: any) => cap.achieved === true);
      response.overall_success = allAchieved;
    }

    return response;
  }

  private compareWithExpected(parsedResponse: any, expected: string): boolean {
    const overallSuccess = parsedResponse.overall_success;
    const confidence = parsedResponse.confidence || 0;
    const expectedLower = expected.toLowerCase();

    // Handle yes/no expectations
    if (expectedLower === 'yes' || expectedLower === 'no') {
      return (expectedLower === 'yes') === overallSuccess;
    }

    // Handle confidence thresholds
    if (expectedLower.includes('+')) {
      const threshold = parseFloat(expectedLower.replace('+', ''));
      return confidence >= threshold;
    }

    // Default: use overall_success from LLM
    return overallSuccess;
  }
}
