export interface LLMModel {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  multiModal?: boolean;
  tier?: "$" | "$$" | "$$$";
  fast?: boolean;
}

export interface LLMModelConfig {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
}

export const models: LLMModel[] = [
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "OpenAI",
    providerId: "openai",
    multiModal: true,
    tier: "$$",
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "OpenAI",
    providerId: "openai",
    multiModal: true,
    tier: "$",
    fast: true,
  },
  {
    id: "openai/gpt-4-turbo",
    name: "GPT-4 Turbo",
    provider: "OpenAI",
    providerId: "openai",
    multiModal: true,
    tier: "$$",
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "Anthropic",
    providerId: "anthropic",
    multiModal: true,
    tier: "$$",
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    provider: "Anthropic",
    providerId: "anthropic",
    multiModal: true,
    tier: "$$$",
  },
  {
    id: "anthropic/claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    provider: "Anthropic",
    providerId: "anthropic",
    multiModal: true,
    tier: "$$",
  },
  {
    id: "google/gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    provider: "Google",
    providerId: "google",
    multiModal: true,
    tier: "$",
    fast: true,
  },
  {
    id: "google/gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    provider: "Google",
    providerId: "google",
    multiModal: true,
    tier: "$$",
  },
  {
    id: "google/gemini-1.5-flash",
    name: "Gemini 1.5 Flash",
    provider: "Google",
    providerId: "google",
    multiModal: true,
    tier: "$",
    fast: true,
  },
];

export default models;
