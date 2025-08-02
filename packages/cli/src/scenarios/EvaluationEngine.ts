import { AgentRuntime } from '@elizaos/core';
import { ExecutionResult } from './providers';
import { Evaluation as EvaluationSchema } from './schema';

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

        const success = new RegExp(params.pattern).test(runResult.stdout);
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