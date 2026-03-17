/**
 * Minimal type shim for @elizaos/core used only when generating .d.ts in this package.
 * At runtime and for consumers, the real @elizaos/core from node_modules is used.
 */
export interface IAgentRuntime {
  getSetting(key: string): string | number | boolean | null | undefined;
  emitEvent(type: string, payload: unknown): void;
  getService(name: string): unknown;
  useModel(type: string, params?: unknown): Promise<unknown>;
  character?: { name?: string; system?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Memory {
  content?: { text?: string };
  metadata?: Record<string, unknown>;
}

export interface State {
  [key: string]: unknown;
}

export interface ProviderResult {
  text?: string;
  values?: Record<string, unknown>;
  data?: unknown;
  [key: string]: unknown;
}

export interface Provider {
  name?: string;
  get?(
    runtime: IAgentRuntime,
    memory: Memory,
    state: State,
  ): Promise<ProviderResult>;
  [key: string]: unknown;
}

export interface ActionResult {
  success: boolean;
  text?: string;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** Content passed to the handler callback (e.g. { text, actions }) */
export interface Content {
  text?: string;
  actions?: string[];
  [key: string]: unknown;
}

/** Callback invoked with response content; returns memories to append */
export type HandlerCallback = (response: Content) => Promise<Memory[]>;

/** Action handler signature */
export type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: Record<string, unknown>,
  callback?: HandlerCallback,
  responses?: Memory[],
) => Promise<ActionResult | undefined>;

export interface Action {
  name: string;
  description: string;
  handler: Handler;
  similes?: string[];
  tags?: string[];
  parameters?: unknown[];
  validate?(runtime: IAgentRuntime): Promise<boolean>;
  [key: string]: unknown;
}

export interface GenerateTextParams {
  prompt: string;
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  maxTokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface TextStreamResult {
  textStream?: unknown;
  text: string | Promise<string>;
  usage?:
    | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    | Promise<
        | {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
          }
        | undefined
      >;
  finishReason?: Promise<string | undefined>;
}

export interface TextEmbeddingParams {
  text?: string | string[] | null;
  modelType?: string;
  [key: string]: unknown;
}

export interface TokenizeTextParams {
  prompt: string;
  modelType?: string;
}

export interface DetokenizeTextParams {
  tokens: number[];
  modelType?: string;
}

export interface ObjectGenerationParams {
  prompt: string;
  temperature?: number;
  [key: string]: unknown;
}

export interface ImageDescriptionParams {
  imageUrl?: string;
  image?: string;
  prompt?: string;
  [key: string]: unknown;
}

export interface ImageGenerationParams {
  prompt: string;
  count?: number;
  size?: string;
  [key: string]: unknown;
}

export interface Plugin {
  name: string;
  description: string;
  config?: Record<string, string | number | boolean | null>;
  init?: (
    config: Record<string, string | number | boolean | null>,
    runtime: IAgentRuntime,
  ) => Promise<void>;
  services?: unknown[];
  actions?: Action[];
  providers?: Provider[];
  [key: string]: unknown;
}

export abstract class Service {
  protected runtime: IAgentRuntime;
  constructor(runtime?: IAgentRuntime);
  abstract stop(): Promise<void>;
  static serviceType: string;
  abstract capabilityDescription: string;
  static start(runtime: IAgentRuntime): Promise<Service>;
}

export const ModelType: Record<string, string>;
export type ModelTypeName = string;

export const EventType: Record<string, string>;

export const VECTOR_DIMS: Record<string, number>;

export const logger: {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
};
