/** Types for the RLM (Recursive Language Model) plugin. */

export type RLMBackend = "openai" | "anthropic" | "gemini" | "groq" | "openrouter";
export type RLMEnvironment = "local" | "docker" | "modal" | "prime";

export interface RLMConfig {
  backend: RLMBackend;
  backendKwargs: Record<string, string>;
  environment: RLMEnvironment;
  maxIterations: number;
  maxDepth: number;
  verbose: boolean;
  pythonPath: string;
  maxRetries?: number;
  retryBaseDelay?: number;
  retryMaxDelay?: number;
}

export interface RLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface RLMMetadata {
  stub: boolean;
  iterations?: number;
  depth?: number;
  error?: string;
}

export interface RLMResult {
  text: string;
  metadata: RLMMetadata;
}

export interface RLMInferOptions {
  /** Model identifier for this request */
  model?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Sampling temperature */
  temperature?: number;
  /** Top-p sampling parameter */
  topP?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** User identifier for tracking */
  user?: string;
  /** Enable streaming (not yet supported by RLM) */
  stream?: boolean;

  // Per-request RLM overrides (Paper Algorithm 1)
  /** Override max iterations for this request */
  maxIterations?: number;
  /** Override max recursion depth for this request */
  maxDepth?: number;
  /** Override root model for this request */
  rootModel?: string;
  /** Override subcall model for this request */
  subcallModel?: string;
  /** Enable trajectory logging for this request */
  logTrajectories?: boolean;
  /** Enable cost tracking for this request */
  trackCosts?: boolean;

  // NOTE: Custom REPL tool injection is NOT supported by the upstream RLM library.
  // See: https://arxiv.org/abs/2512.24601 Section 3.3 - the paper describes the concept
  // but the current library implementation does not expose this capability.
}

export interface RLMStatusResponse {
  available: boolean;
  backend: string;
  environment: string;
  maxIterations: number;
  maxDepth: number;
}

export interface IPCRequest {
  id: number;
  method: "infer" | "status" | "shutdown";
  params: Record<string, unknown>;
}

export interface IPCResponse<T = unknown> {
  id: number;
  result?: T;
  error?: string;
}

export interface IPCReadyMessage {
  ready: boolean;
  available: boolean;
}

export interface GenerateTextParams {
  prompt?: string;
  system?: string;
  messages?: RLMMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  user?: string;
  stream?: boolean;
}

export const DEFAULT_CONFIG: RLMConfig = {
  backend: "gemini",
  backendKwargs: {},
  environment: "local",
  maxIterations: 4,
  maxDepth: 1,
  verbose: false,
  pythonPath: "python",
  maxRetries: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 30000,
};

export interface RLMMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  stubResponses: number;
  totalRetries: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  lastRequestTimestamp: number;
  lastErrorTimestamp?: number;
  lastError?: string;
}

export type MetricsCallback = (metrics: RLMMetrics) => void;

export const ENV_VARS = {
  BACKEND: "ELIZA_RLM_BACKEND",
  ENVIRONMENT: "ELIZA_RLM_ENV",
  MAX_ITERATIONS: "ELIZA_RLM_MAX_ITERATIONS",
  MAX_DEPTH: "ELIZA_RLM_MAX_DEPTH",
  VERBOSE: "ELIZA_RLM_VERBOSE",
  PYTHON_PATH: "ELIZA_RLM_PYTHON_PATH",
  MAX_RETRIES: "ELIZA_RLM_MAX_RETRIES",
  RETRY_BASE_DELAY: "ELIZA_RLM_RETRY_BASE_DELAY",
  RETRY_MAX_DELAY: "ELIZA_RLM_RETRY_MAX_DELAY",
} as const;

export const VALID_BACKENDS: readonly RLMBackend[] = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "openrouter",
];
export const VALID_ENVIRONMENTS: readonly RLMEnvironment[] = ["local", "docker", "modal", "prime"];

export class RLMConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RLMConfigError";
  }
}

/** Validate config. Returns errors array, or throws if strict=true. */
export function validateConfig(config: Partial<RLMConfig>, strict = false): string[] {
  const errors: string[] = [];

  if (config.backend !== undefined && !VALID_BACKENDS.includes(config.backend)) {
    errors.push(`Invalid backend '${config.backend}'. Valid options: ${VALID_BACKENDS.join(", ")}`);
  }

  if (config.environment !== undefined && !VALID_ENVIRONMENTS.includes(config.environment)) {
    errors.push(
      `Invalid environment '${config.environment}'. Valid options: ${VALID_ENVIRONMENTS.join(", ")}`,
    );
  }

  if (config.maxIterations !== undefined && config.maxIterations < 1) {
    errors.push("maxIterations must be >= 1");
  }

  if (config.maxDepth !== undefined && config.maxDepth < 1) {
    errors.push("maxDepth must be >= 1");
  }

  if (config.maxRetries !== undefined && config.maxRetries < 0) {
    errors.push("maxRetries must be >= 0");
  }

  if (config.retryBaseDelay !== undefined && config.retryBaseDelay < 0) {
    errors.push("retryBaseDelay must be >= 0");
  }

  if (
    config.retryBaseDelay !== undefined &&
    config.retryMaxDelay !== undefined &&
    config.retryMaxDelay < config.retryBaseDelay
  ) {
    errors.push("retryMaxDelay must be >= retryBaseDelay");
  }

  if (strict && errors.length > 0) {
    throw new RLMConfigError(errors.join("; "));
  }

  return errors;
}
