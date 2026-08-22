/** Defines deterministic model-provider fixtures, faults, observations, and readback state. */

export type ModelProviderOperation =
  | "configured-embedding"
  | "google-count-tokens"
  | "google-embedding"
  | "google-generate"
  | "ollama-version"
  | "ollama-model-show"
  | "ollama-model-pull"
  | "ollama-chat"
  | "ollama-embedding"
  | "zai-chat";

export type ModelProviderFault =
  | {
      type: "http";
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
    }
  | { type: "malformed"; body?: string }
  | { type: "delay"; delayMs: number };

export interface ModelProviderSeed {
  auth?: Partial<Record<"configured-embedding" | "google" | "zai", string>>;
  configuredEmbedding?: {
    model: string;
    dimensions: number;
    vectors: Record<string, number[]>;
    promptTokens?: number;
  };
  google?: {
    text: string;
    embedding: number[];
    inputTokens: number;
    outputTokens?: number;
  };
  ollama?: {
    distribution?: "ollama" | "zerollama";
    models: string[];
    text: string;
    streamChunks?: string[];
    embedding: number[];
    promptTokens?: number;
    completionTokens?: number;
  };
  zai?: {
    model: string;
    text: string;
    promptTokens?: number;
    completionTokens?: number;
  };
  faults?: Partial<Record<ModelProviderOperation, ModelProviderFault[]>>;
}

export interface ModelProviderObservation {
  sequence: number;
  generation: number;
  operation: ModelProviderOperation;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
}

export interface ModelProviderReadback {
  generation: number;
  observations: ModelProviderObservation[];
  staleObservations: ModelProviderObservation[];
  ollamaModels: string[];
  remainingFaults: Partial<Record<ModelProviderOperation, number>>;
}
