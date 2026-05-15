import { type JudgeResponse } from "../../../../packages/scenario-runner/src/cerebras-judge.ts";
export interface CerebrasChatRequest {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: "low" | "medium" | "high";
}
export interface CerebrasChatUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
}
export interface CerebrasChatResponse {
    text: string;
    usage?: CerebrasChatUsage;
    raw?: unknown;
}
export type EvalModelClient = (req: CerebrasChatRequest) => Promise<CerebrasChatResponse>;
export declare function getEvalModelClient(): EvalModelClient;
export declare function getTrainingModelClient(): EvalModelClient;
/**
 * Cerebras-only judge helper. Routes through the shared `CerebrasJudge`
 * transport (tolerant parsing, 429/5xx retry, json_object opt-in). Returns
 * the raw model text for backward compatibility with existing callers.
 * New callers should consume `judgeWithCerebrasShared()` (below) to get
 * the canonical parsed shape.
 */
export declare function judgeWithCerebras(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
}): Promise<string>;
/**
 * New canonical entry: returns the full JudgeResponse for callers that
 * want the parsed score/verdict/reason without re-parsing the raw text.
 */
export declare function judgeWithCerebrasShared(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
}): Promise<JudgeResponse>;
export declare function getTrainingUseModelAdapter(): (input: {
    prompt: string;
    temperature?: number;
    maxTokens?: number;
}) => Promise<string>;
export declare function isCerebrasEvalEnabled(): boolean;
export declare function isCerebrasTrainingEnabled(): boolean;
//# sourceMappingURL=lifeops-eval-model.d.ts.map