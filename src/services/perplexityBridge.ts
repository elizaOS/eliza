export interface PerplexityAgentOptions {
  model?: string;
  searchType?: "fast" | "pro";
  temperature?: number;
}

export class PerplexityAgentBridge {
  private apiKey: string;
  private endpoint: string;

  constructor(apiKey: string, endpoint = "https://api.perplexity.ai/chat/completions") {
    this.apiKey = apiKey.trim();
    this.endpoint = endpoint;
  }

  async queryAgent(prompt: string, options: PerplexityAgentOptions = {}): Promise<string> {
    const model = options.model ?? "sonar";
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
