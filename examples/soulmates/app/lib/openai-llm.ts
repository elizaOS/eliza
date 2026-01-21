import { createDefaultLlmProvider } from "@engine/llm";
import type {
  LargePassInput,
  LargePassResult,
  LlmProvider,
  SmallPassInput,
  SmallPassResult,
} from "@engine/types";
import { clampInt } from "@engine/utils";
import { readEnv } from "@/lib/env";

type OpenAiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OpenAiChoice = {
  message?: {
    content?: string;
  };
};

type OpenAiResponse = {
  choices?: OpenAiChoice[];
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

const buildSummary = (
  label: string,
  data: Record<string, string | number | string[]>,
): string => {
  const lines = Object.entries(data).map(([key, value]) => {
    const formatted = Array.isArray(value) ? value.join(", ") : String(value);
    return `${key}: ${formatted}`;
  });
  return `${label}:\n${lines.join("\n")}`;
};

const normalizeReasons = (value: string[] | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string").slice(0, 5)
    : [];

const parseLargePass = (content: string): LargePassResult | null => {
  const parsed = JSON.parse(content) as {
    score?: number;
    positiveReasons?: string[];
    negativeReasons?: string[];
    redFlags?: string[];
    notes?: string;
  };

  if (typeof parsed.score !== "number") return null;
  const score = clampInt(parsed.score, -100, 100);
  const positiveReasons = normalizeReasons(parsed.positiveReasons);
  const negativeReasons = normalizeReasons(parsed.negativeReasons);
  const redFlags = normalizeReasons(parsed.redFlags);
  const notes =
    typeof parsed.notes === "string" ? parsed.notes : "LLM match assessment";

  return {
    score,
    positiveReasons,
    negativeReasons,
    redFlags,
    notes,
  };
};

const buildLargePassMessages = (input: LargePassInput): OpenAiMessage[] => {
  const persona = input.persona;
  const candidate = input.candidate;
  const personaSummary = buildSummary("Persona", {
    id: persona.id,
    age: persona.general.age,
    gender: persona.general.genderIdentity,
    city: persona.general.location.city,
    timeZone: persona.profile.availability.timeZone,
    interests: persona.profile.interests,
    cadence: persona.profile.meetingCadence,
    reliability: persona.reliability.score,
  });
  const candidateSummary = buildSummary("Candidate", {
    id: candidate.id,
    age: candidate.general.age,
    gender: candidate.general.genderIdentity,
    city: candidate.general.location.city,
    timeZone: candidate.profile.availability.timeZone,
    interests: candidate.profile.interests,
    cadence: candidate.profile.meetingCadence,
    reliability: candidate.reliability.score,
  });

  return [
    {
      role: "system",
      content:
        "You are Ori's compatibility evaluator. Return strict JSON only.",
    },
    {
      role: "user",
      content: [
        `Domain: ${input.domain}`,
        personaSummary,
        candidateSummary,
        "Return JSON with keys: score (-100 to 100), positiveReasons (array), negativeReasons (array), redFlags (array), notes.",
      ].join("\n\n"),
    },
  ];
};

const callOpenAi = async (
  apiKey: string,
  model: string,
  messages: OpenAiMessage[],
): Promise<string> => {
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as OpenAiResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response missing content.");
  }
  return content;
};

class OpenAiLlmProvider implements LlmProvider {
  private apiKey: string;
  private model: string;
  private fallback: LlmProvider;

  constructor(apiKey: string, model: string, fallback: LlmProvider) {
    this.apiKey = apiKey;
    this.model = model;
    this.fallback = fallback;
  }

  async smallPass(input: SmallPassInput): Promise<SmallPassResult> {
    return this.fallback.smallPass(input);
  }

  async largePass(input: LargePassInput): Promise<LargePassResult> {
    try {
      const messages = buildLargePassMessages(input);
      const content = await callOpenAi(this.apiKey, this.model, messages);
      const parsed = parseLargePass(content);
      if (!parsed) {
        return this.fallback.largePass(input);
      }
      return parsed;
    } catch (_err) {
      return this.fallback.largePass(input);
    }
  }
}

export const createOpenAiLlmProvider = (): LlmProvider => {
  const apiKey = readEnv("OPENAI_API_KEY");
  if (!apiKey) {
    return createDefaultLlmProvider();
  }
  const model = readEnv("SOULMATES_MATCHING_OPENAI_MODEL") ?? DEFAULT_MODEL;
  return new OpenAiLlmProvider(apiKey, model, createDefaultLlmProvider());
};
