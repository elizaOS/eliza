export const ModelType = {
  NANO: "TEXT_NANO",
  SMALL: "TEXT_SMALL",
  MEDIUM: "TEXT_MEDIUM",
  LARGE: "TEXT_LARGE",
  MEGA: "TEXT_MEGA",
  TEXT_NANO: "TEXT_NANO",
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_MEDIUM: "TEXT_MEDIUM",
  TEXT_LARGE: "TEXT_LARGE",
  TEXT_MEGA: "TEXT_MEGA",
  RESPONSE_HANDLER: "RESPONSE_HANDLER",
  ACTION_PLANNER: "ACTION_PLANNER",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",
  TEXT_REASONING_SMALL: "REASONING_SMALL",
  TEXT_REASONING_LARGE: "REASONING_LARGE",
  TEXT_COMPLETION: "TEXT_COMPLETION",
  IMAGE: "IMAGE",
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
  TRANSCRIPTION: "TRANSCRIPTION",
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
  AUDIO: "AUDIO",
  VIDEO: "VIDEO",
  RESEARCH: "RESEARCH",
} as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type ModelTypeName = (typeof ModelType)[keyof typeof ModelType];

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: JsonValue;
};

export type ToolCall = {
  name: string;
  arguments: Record<string, JsonValue>;
};

export type GenerateTextParams = {
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  tools?: ToolDefinition[];
  responseSchema?: JsonValue;
};

export type GenerateTextResult = {
  text: string;
  finishReason: string;
  toolCalls?: ToolCall[];
};

export type IAgentRuntime = Record<string, never>;

export type Plugin = {
  name: string;
  description?: string;
  priority?: number;
  models?: Partial<
    Record<
      ModelTypeName,
      (
        runtime: IAgentRuntime,
        params: GenerateTextParams,
      ) =>
        | JsonValue
        | GenerateTextResult
        | Promise<JsonValue | GenerateTextResult>
    >
  >;
};
