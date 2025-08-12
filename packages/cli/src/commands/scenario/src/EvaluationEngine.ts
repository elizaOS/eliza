import { AgentRuntime, ModelType } from '@elizaos/core';
import { ExecutionResult } from './providers';
import { Evaluation as EvaluationSchema } from './schema';
import { z } from 'zod';
import type { ObjectGenerationParams } from '@elizaos/core';

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
                    message: `Unknown evaluator type: '${evaluation.type}'`
                });
                continue;
            }

            const result = await evaluator.evaluate(evaluation, runResult, this.runtime);
            results.push(result);
        }

        return results;
    }
}

// --- IMPLEMENTATIONS ---

class StringContainsEvaluator implements Evaluator {
    async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
        if (params.type !== 'string_contains') throw new Error('Mismatched evaluator');

        const success = runResult.stdout.includes(params.value);
        return {
            success,
            message: `Checked if stdout contains "${params.value}". Result: ${success}`,
        };
    }
}

class RegexMatchEvaluator implements Evaluator {
    async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
        if (params.type !== 'regex_match') throw new Error('Mismatched evaluator');

        const success = new RegExp(params.pattern, 'i').test(runResult.stdout);
        return {
            success,
            message: `Checked if stdout matches regex "${params.pattern}". Result: ${success}`,
        };
    }
}

class FileExistsEvaluator implements Evaluator {
    async evaluate(params: EvaluationSchema, runResult: ExecutionResult): Promise<EvaluationResult> {
        if (params.type !== 'file_exists') throw new Error('Mismatched evaluator');

        // Check for both exact path and relative path (with ./ prefix)
        const filePaths = Object.keys(runResult.files);
        const success = filePaths.includes(params.path) ||
            filePaths.includes(`./${params.path}`) ||
            filePaths.includes(params.path.replace(/^\.\//, ''));

        return {
            success,
            message: `Checked if file "${params.path}" exists. Result: ${success}`,
        };
    }
}

export class TrajectoryContainsActionEvaluator implements Evaluator {
    async evaluate(params: EvaluationSchema, runResult: ExecutionResult, runtime: AgentRuntime): Promise<EvaluationResult> {
        if (params.type !== 'trajectory_contains_action') throw new Error('Mismatched evaluator');

        const actionName = params.action;

        try {
            // Get action memories from database
            const actionMemories = await runtime.getMemories({
                tableName: 'messages',
                agentId: runtime.agentId,
                count: 50, // Get recent actions
                unique: false,
            });
            console.log('actionMemories', actionMemories);

            // Filter for action_result memories
            const actionResults = actionMemories.filter(
                (mem) => mem?.type === 'messages' && mem.content?.type === 'action_result'
            );
            console.log('actionResults', actionResults);
            // Normalize function to compare action names robustly (case/underscore insensitive)
            const normalize = (name: string | undefined): string => (typeof name === 'string' ? name : '').toLowerCase().replace(/_/g, '');
            const target = normalize(actionName);
            console.log('target', target);

            // Check if any action matches the specified name (normalized)
            const matchingAction = actionResults.find((mem) => normalize(mem.content?.actionName ?? '') === target);

            if (!matchingAction) {
                return {
                    success: false,
                    message: `Action '${actionName}' was not found in the execution trajectory`,
                };
            }

            const actionStatus = matchingAction.content?.actionStatus || 'unknown';
            const message = actionStatus === 'completed'
                ? `Action '${actionName}' was executed successfully`
                : `Action '${actionName}' was executed but failed: ${matchingAction.content?.error || 'Unknown error'}`;

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
    async evaluate(params: EvaluationSchema, runResult: ExecutionResult, runtime: AgentRuntime): Promise<EvaluationResult> {
        if (params.type !== 'llm_judge') throw new Error('Mismatched evaluator');

        const prompt = params.prompt;
        const expected = params.expected;
        // Try OBJECT_SMALL first, then TEXT_LARGE/TEXT_SMALL
        const candidateModels = [ModelType.OBJECT_SMALL, ModelType.TEXT_LARGE, ModelType.TEXT_SMALL];
        const temperature = params.temperature || 0.1;
        const jsonSchema = (params.json_schema as any) || this.getDefaultJudgmentSchema();
        const timeoutMs = Number(process.env.LLM_JUDGE_TIMEOUT_MS || 15000);

        // Pick first available model
        let modelType: ModelType = candidateModels.find((m) => (runtime as any).getModel?.(m)) ?? ModelType.TEXT_LARGE;

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
            console.log(`[LLM Judge] Starting evaluation for prompt: "${prompt}"`);
            console.log(`[LLM Judge] Using model type: ${modelType}`);
            console.log(`[LLM Judge] Temperature: ${temperature}`);

            // Check if the picked model is available; if not, return gracefully
            const availableModels = (runtime as any).models;
            const modelKeys = availableModels && typeof availableModels.keys === 'function'
                ? Array.from(availableModels.keys())
                : Object.keys(availableModels || {});
            console.log(`[LLM Judge] Available models:`, modelKeys);
            const modelHandler = (runtime as any).getModel(modelType);
            console.log(`[LLM Judge] Model handler for ${modelType}:`, modelHandler ? 'EXISTS' : 'NOT FOUND');
            if (!modelHandler) {
                return {
                    success: false,
                    message: `LLM judge: no available model handler (tried ${candidateModels.join(', ')})`,
                };
            }

            // Check if OpenAI plugin is loaded
            const openaiService = runtime.getService('openai');
            console.log(`[LLM Judge] OpenAI service:`, openaiService ? 'LOADED' : 'NOT FOUND');

            // Check all loaded services
            const allServices = (runtime as any).services;
            console.log(`[LLM Judge] All loaded services:`, Object.keys(allServices || {}));

            // Do not include runtime here; runtime.useModel will inject it
            const objectParams: Omit<ObjectGenerationParams, 'runtime'> = {
                prompt: fullPrompt,
                schema: jsonSchema,
                temperature,
                output: 'object',
            } as any;

            // Safe log (no runtime field)
            console.log(`[LLM Judge] Calling useModel with params:`, JSON.stringify(objectParams, null, 2));
            const response = await Promise.race([
                runtime.useModel(modelType, objectParams),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`LLM judge timeout after ${timeoutMs}ms`)), timeoutMs)),
            ]);
            console.log(`[LLM Judge] Received response:`, JSON.stringify(response, null, 2));

            // The object model should return a proper object, but let's validate it
            const parsedResponse = this.validateResponse(response, jsonSchema);

            // Compare with expected result
            const success = this.compareWithExpected(parsedResponse, expected);

            return {
                success,
                message: `LLM judgment: ${parsedResponse.judgment} (confidence: ${parsedResponse.confidence}). Expected: "${expected}". Result: ${success}`,
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
            type: "object",
            properties: {
                judgment: { type: "string", enum: ["yes", "no"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                reasoning: { type: "string" }
            },
            required: ["judgment", "confidence", "reasoning"]
        };
    }

    private validateResponse(response: any, schema: any): any {
        // The object model should return a proper object, but let's validate it
        if (typeof response === 'string') {
            // Fallback: parse as JSON if it's a string
            const parsed = JSON.parse(response);
            return this.validateWithZod(parsed, schema);
        }

        // If it's already an object, validate it directly
        return this.validateWithZod(response, schema);
    }

    private validateWithZod(response: any, schema: any): any {
        try {
            const zodSchema = this.convertToZodSchema(schema);
            return zodSchema.parse(response);
        } catch (error) {
            console.log(`[LLM Judge] Zod validation failed:`, error);
            console.log(`[LLM Judge] Response was:`, JSON.stringify(response, null, 2));
            console.log(`[LLM Judge] Expected schema:`, JSON.stringify(schema, null, 2));
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