import type { SelectedLiveProvider } from "./lifeops-live-harness.ts";

type ProviderModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: SelectedLiveProvider["name"];
};

export type LlmJudgeResult = {
  passed: boolean;
  reasoning: string;
  score: number;
};

function resolveProviderModelConfig(
  provider: SelectedLiveProvider,
): ProviderModelConfig {
  switch (provider.name) {
    case "anthropic":
      return {
        apiKey: provider.env.ANTHROPIC_API_KEY,
        baseUrl: "https://api.anthropic.com",
        model:
          provider.env.ANTHROPIC_SMALL_MODEL ||
          provider.env.ANTHROPIC_LARGE_MODEL ||
          "claude-haiku-4-5-20251001",
        providerName: provider.name,
      };
    case "google":
      return {
        apiKey:
          provider.env.GOOGLE_GENERATIVE_AI_API_KEY ||
          provider.env.GOOGLE_API_KEY,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model:
          provider.env.GOOGLE_SMALL_MODEL ||
          provider.env.GOOGLE_LARGE_MODEL ||
          "gemini-2.5-flash",
        providerName: provider.name,
      };
    case "groq":
      return {
        apiKey: provider.env.GROQ_API_KEY,
        baseUrl: "https://api.groq.com/openai/v1",
        model:
          provider.env.GROQ_SMALL_MODEL ||
          provider.env.GROQ_LARGE_MODEL ||
          "llama-3.1-8b-instant",
        providerName: provider.name,
      };
    case "openrouter":
      return {
        apiKey: provider.env.OPENROUTER_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1",
        model:
          provider.env.OPENROUTER_SMALL_MODEL ||
          provider.env.OPENROUTER_LARGE_MODEL ||
          "google/gemini-2.5-flash",
        providerName: provider.name,
      };
    default:
      return {
        apiKey: provider.env.OPENAI_API_KEY,
        baseUrl: provider.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        model:
          provider.env.OPENAI_SMALL_MODEL ||
          provider.env.OPENAI_LARGE_MODEL ||
          "gpt-5.4-mini",
        providerName: "openai",
      };
  }
}

async function callOpenAiCompatible(
  config: ProviderModelConfig,
  prompt: string,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 700,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${config.providerName} judge error ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(
  config: ProviderModelConfig,
  prompt: string,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `anthropic judge error ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as {
    content?: Array<{ text?: string }>;
  };
  return data.content?.[0]?.text ?? "";
}

async function callGoogle(
  config: ProviderModelConfig,
  prompt: string,
): Promise<string> {
  const url = `${config.baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 700 },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `google judge error ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callProvider(
  provider: SelectedLiveProvider,
  prompt: string,
): Promise<string> {
  const config = resolveProviderModelConfig(provider);
  if (config.providerName === "anthropic") {
    return callAnthropic(config, prompt);
  }
  if (config.providerName === "google") {
    return callGoogle(config, prompt);
  }
  return callOpenAiCompatible(config, prompt);
}

function parseJudgeResult(raw: string): LlmJudgeResult | null {
  const trimmed = raw.trim();
  const fenced = trimmed.replace(/^```json\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(fenced) as {
      passed?: unknown;
      reasoning?: unknown;
      score?: unknown;
    };
    if (
      typeof parsed.passed !== "boolean" ||
      typeof parsed.reasoning !== "string" ||
      typeof parsed.score !== "number" ||
      !Number.isFinite(parsed.score)
    ) {
      return null;
    }
    return {
      passed: parsed.passed,
      reasoning: parsed.reasoning.trim(),
      score: Math.max(0, Math.min(1, parsed.score)),
    };
  } catch {
    return null;
  }
}

function buildJudgePrompt(args: {
  rubric: string;
  text: string;
  minimumScore: number;
  label: string;
  transcript?: string;
}): string {
  return [
    "Judge whether the assistant output satisfies the rubric.",
    "Return ONLY valid JSON with exactly these fields:",
    '  {"passed": boolean, "score": number, "reasoning": string}',
    "",
    `Label: ${args.label}`,
    `Minimum passing score: ${args.minimumScore}`,
    `Rubric: ${args.rubric}`,
    args.transcript
      ? `Conversation context: ${JSON.stringify(args.transcript)}`
      : "",
    `Assistant output: ${JSON.stringify(args.text)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function judgeTextWithLlm(args: {
  provider: SelectedLiveProvider;
  rubric: string;
  text: string;
  minimumScore?: number;
  label: string;
  transcript?: string;
}): Promise<LlmJudgeResult> {
  const minimumScore = args.minimumScore ?? 0.75;
  const prompt = buildJudgePrompt({
    rubric: args.rubric,
    text: args.text,
    minimumScore,
    label: args.label,
    transcript: args.transcript,
  });
  const raw = await callProvider(args.provider, prompt);
  const parsed = parseJudgeResult(raw);
  if (!parsed) {
    throw new Error(`Judge returned invalid JSON for ${args.label}: ${raw}`);
  }
  return {
    ...parsed,
    passed: parsed.passed && parsed.score >= minimumScore,
  };
}
