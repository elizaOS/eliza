export interface PerplexityAgentOptions {
  model?: string;
  searchType?: "fast" | "pro";
  temperature?: number;
}

export class PerplexityAgentBridge {
  private apiKey: string;
  private endpoint: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey.trim();
    const base = (baseUrl || (typeof process !== "undefined" ? process.env?.PERPLEXITY_BASE_URL : "") || "https://api.perplexity.ai").replace(/\/+$/, "");
    this.endpoint = `${base}/chat/completions`;
  }

  async queryAgent(prompt: string, options: PerplexityAgentOptions = {}): Promise<string> {
    const defaultModel = (typeof process !== "undefined" ? process.env?.DEFAULT_SEARCH_MODEL : "") || "sonar";
    const model = options.model ?? defaultModel;
    const temperature = options.temperature ?? 0.2;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        search_domain_filter: [],
        return_images: false,
        return_related_questions: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[PERPLEXITY BRIDGE ERROR] HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "No content returned from Perplexity.";
  }
}
