/**
 * Shared Cerebras judge transport.
 *
 * Single class consumed by all Cerebras-as-judge call sites in the repo:
 *
 *   - packages/scenario-runner/src/judge.ts                 (scenario judge)
 *   - plugins/app-lifeops/test/helpers/lifeops-live-judge.ts (lifeops live judge)
 *   - plugins/app-training/src/core/cerebras-eval-model.ts  (training judge)
 *   - packages/benchmarks/personality-bench/src/judge/checks/llm-judge.ts
 *                                                           (personality multi-pass judge)
 *
 * Prompts, rubrics, and pass counts stay with the callers. This class only
 * owns transport, retry, tolerant JSON parsing, and a canonical verdict
 * shape. Callers map the canonical shape back to their own return types.
 */
/** Canonical verdict alias re-exported for callers that don't pull types.ts. */
export type CerebrasJudgeVerdict = "PASS" | "FAIL" | "REVIEW";
/** Verdicts produced by personality-bench style judges that use NEEDS_REVIEW. */
export type CerebrasJudgeVerdictWide = CerebrasJudgeVerdict | "NEEDS_REVIEW";
/** Canonical response shape every Cerebras judge call resolves to. */
export interface JudgeResponse {
    /** Raw model text — exactly what the API returned, before parsing. */
    raw: string;
    /** Parsed JSON object or null if the model output never parsed. */
    json: Record<string, unknown> | null;
    /** 0..1 score when the model emitted a `score` field. */
    score?: number;
    /** Canonical verdict when the model emitted `verdict` or it can be derived from `score`. */
    verdict?: CerebrasJudgeVerdict;
    /** Free-text justification when the model emitted `reason` (or equivalent). */
    reason?: string;
}
export interface CerebrasJudgeOptions {
    /** Default `gpt-oss-120b`. Override per call via judge() options if needed. */
    model?: string;
    /** OpenAI-compatible base. Default `https://api.cerebras.ai/v1`. */
    baseUrl?: string;
    /** Bearer key. Defaults to `process.env.CEREBRAS_API_KEY`. */
    apiKey?: string;
    /** Per-request abort timeout. Default 60000ms. */
    timeoutMs?: number;
    /** Retry count on 429/5xx (transport-only retries, not parse retries). Default 2. */
    maxRetries?: number;
}
export interface JudgeCallOptions {
    /** Max output tokens. Default 1024. */
    maxTokens?: number;
    /** Temperature. Default 0. */
    temperature?: number;
    /** Optional system prompt. */
    systemPrompt?: string;
    /** When true, sets `response_format: { type: "json_object" }`. Default false. */
    jsonObjectMode?: boolean;
    /** Reasoning effort hint for `gpt-oss-*` models. Default "low" for fast judges. */
    reasoningEffort?: "low" | "medium" | "high";
}
/**
 * Walk a string and return the first balanced `{...}` window, respecting
 * string boundaries and escape sequences. Used as a tolerant fallback when
 * the model wraps the JSON in prose. Returns null when no balanced object
 * is found.
 *
 * Exported because the scenario-runner judge (and the test suite) use it
 * directly.
 */
export declare function extractBalancedJsonObject(raw: string): string | null;
/**
 * Tolerant JSON parser. Tries: strict parse → ```json fenced parse →
 * first-`{` to last-`}` window → balanced-object scan. Returns null when
 * the model output never resolves to a JSON object.
 */
export declare function tolerantJsonParse(text: string): Record<string, unknown> | null;
/**
 * Map a numeric score to a canonical verdict. Threshold: `>= 0.75` is PASS,
 * `<= 0.25` is FAIL, anything in between is REVIEW. This is an additive
 * field on JudgeResponse — callers that have their own verdict logic ignore
 * it.
 */
export declare function verdictFromScore(score: number): CerebrasJudgeVerdict;
/**
 * Map a string verdict produced by the model to the canonical
 * PASS/FAIL/REVIEW set. Returns undefined when the input isn't a recognized
 * verdict string. Accepts YES/NO/NEEDS_REVIEW (personality-bench style) and
 * PASS/FAIL/REVIEW (scenario-runner style).
 */
export declare function normalizeVerdict(raw: unknown): CerebrasJudgeVerdict | undefined;
/**
 * Cerebras gpt-oss-120b judge transport.
 *
 * Single shared client for the four judge call sites in this repo. Owns
 * transport (HTTP, auth, abort, retry, response_format) and parsing.
 * Prompt construction and verdict mapping belong to callers — this class
 * gives them a canonical {raw, json, score?, verdict?, reason?} response
 * they can map onto their own return types.
 */
export declare class CerebrasJudge {
    private readonly model;
    private readonly baseUrl;
    private readonly apiKey;
    private readonly timeoutMs;
    private readonly maxRetries;
    constructor(options?: CerebrasJudgeOptions);
    /** Returns true when an API key is present in env. */
    static isAvailable(): boolean;
    /**
     * Execute a single judge call. Retries on 429/5xx (up to `maxRetries`
     * times) with exponential backoff. Throws on 4xx (other than 429) and
     * after retries are exhausted.
     */
    judge(prompt: string, options?: JudgeCallOptions): Promise<JudgeResponse>;
    /**
     * Internal: dispatch one chat completion with retries on 429/5xx.
     * Returns the raw assistant content (no parsing). Exposed via judge();
     * not exported because the parsed surface is the contract.
     */
    private callChat;
    private buildMessages;
}
//# sourceMappingURL=cerebras-judge.d.ts.map