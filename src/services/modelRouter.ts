import { PerplexityAgentBridge, PerplexityAgentOptions } from "./perplexityBridge";

export interface ModelRouterConfig {
  perplexityApiKey?: string;
  geminiApiKey?: string;
  defaultModel?: string;
}

export interface RoutePromptOptions extends PerplexityAgentOptions {
  tier?: "fast" | "deep" | "local";
}

/**
 * ModelStackRouter routes research, extraction, and reasoning prompts across
 * Perplexity's Sonar models for real-time web grounding and Gemini 2.0 Flash
 * for generative synthesis.
 */
export class ModelStackRouter {
  private perplexityBridge: PerplexityAgentBridge | null = null;
  private geminiKey: string | null = null;

  constructor(config: ModelRouterConfig = {}) {
    const pKey = config.perplexityApiKey || (typeof process !== "undefined" ? process.env?.PERPLEXITY_API_KEY : "");
    if (pKey) {
      this.perplexityBridge = new PerplexityAgentBridge(pKey);
    }
    this.geminiKey = config.geminiApiKey || (typeof process !== "undefined" ? process.env?.GEMINI_API_KEY : "") || null;
  }

  async routePrompt(prompt: string, options: RoutePromptOptions = {}): Promise<{ content: string; provider: string }> {
    // 1. Prioritize Perplexity Sonar with Fast Search for grounding & market extraction
    if (this.perplexityBridge && (options.tier === "fast" || !options.tier)) {
      try {
        const content = await this.perplexityBridge.queryAgent(prompt, {
          model: options.model || "sonar",
          searchType: options.searchType || "fast",
          temperature: options.temperature || 0.2,
        });
        return { content, provider: "perplexity-sonar-fast" };
      } catch (err: any) {
        console.warn("[MODEL ROUTER] Perplexity Tier fell back:", err.message);
      }
    }

    // 2. Gemini 2.0 Flash Tier
    if (this.geminiKey) {
      try {
        const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.geminiKey}`;
        const res = await fetch(geminiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1024, temperature: options.temperature || 0.7 },
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
          return { content, provider: "gemini-2.0-flash" };
        }
      } catch (err: any) {
        console.warn("[MODEL ROUTER] Gemini Tier fell back:", err.message);
      }
    }

    // 3. Fallback Context
    return {
      content: `[VALHALLA MODEL ROUTER]: Context for "${prompt}" — active DEX volume on Solana. Configure PERPLEXITY_API_KEY or GEMINI_API_KEY for dynamic generative synthesis.`,
      provider: "valhalla-fallback",
    };
  }
}
