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
export type EvalModelClient = (
  req: CerebrasChatRequest,
) => Promise<CerebrasChatResponse>;
export declare function getEvalModelClient(): EvalModelClient;
export declare function getTrainingModelClient(): EvalModelClient;
export declare function judgeWithCerebras(
  prompt: string,
  options?: {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
  },
): Promise<string>;
export declare function getTrainingUseModelAdapter(): (input: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string>;
export declare function isCerebrasEvalEnabled(): boolean;
export declare function isCerebrasTrainingEnabled(): boolean;
//# sourceMappingURL=lifeops-eval-model.d.ts.map
