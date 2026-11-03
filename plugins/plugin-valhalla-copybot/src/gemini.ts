const GEMINI_HOST = "generativelanguage.googleapis.com";

export interface GeminiRequest {
  apiKey: string;
  model: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

function assertStudioModel(model: string): string {
  const name = model.trim();
  if (!/^gemini-[a-z0-9.-]+$/i.test(name)) {
    throw new Error("Gemini model name must be an AI Studio model id such as gemini-2.5-flash.");
  }
  return name;
}

export function geminiGenerateUrl(model: string, apiKey: string): string {
  const name = assertStudioModel(model);
  const url = new URL(`https://${GEMINI_HOST}/v1beta/models/${name}:generateContent`);
  url.searchParams.set("key", apiKey);
  if (url.hostname !== GEMINI_HOST) {
    throw new Error("Refusing a non AI Studio host.");
  }
  return url.toString();
}

export async function generateWithGemini(request: GeminiRequest): Promise<string> {
  const key = request.apiKey.trim();
  if (!key) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");
  const url = geminiGenerateUrl(request.model, key);
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens ?? 1024,
      temperature: request.temperature ?? 0.2,
    },
  };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.split(key).join("[redacted]") : "network";
    throw new Error(`Gemini request failed: ${message}`);
  }
  if (!response.ok) {
    throw new Error(`Gemini HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini returned no text.");
  return text;
}

export function promptOf(
  params: { prompt?: string; system?: string } | string | null | undefined
): {
  prompt: string;
  system?: string;
} {
  if (typeof params === "string") return { prompt: params };
  if (!params) return { prompt: "" };
  return params.system
    ? { prompt: params.prompt ?? "", system: params.system }
    : { prompt: params.prompt ?? "" };
}
