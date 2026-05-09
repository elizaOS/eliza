import { getLogPrefix } from "@elizaos/shared";
import type { Command } from "commander";

export function registerModelsCli(program: Command) {
  program
    .command("models")
    .description("Show configured model providers")
    .action(() => {
      const envKeys = [
        ["ANTHROPIC_API_KEY", "Anthropic (Claude)"],
        ["OPENAI_API_KEY", "OpenAI (GPT)"],
        ["AI_GATEWAY_API_KEY", "Vercel AI Gateway"],
        ["GOOGLE_API_KEY", "Google (Gemini)"],
        ["GOOGLE_CLOUD_API_KEY", "Google Antigravity (Vertex AI)"],
        ["GROQ_API_KEY", "Groq"],
        ["XAI_API_KEY", "xAI (Grok)"],
        ["OPENROUTER_API_KEY", "OpenRouter"],
        ["DEEPSEEK_API_KEY", "DeepSeek"],
        ["TOGETHER_API_KEY", "Together AI"],
        ["MISTRAL_API_KEY", "Mistral"],
        ["COHERE_API_KEY", "Cohere"],
        ["PERPLEXITY_API_KEY", "Perplexity"],
        ["ZAI_API_KEY", "Zai"],
        ["MOONSHOT_API_KEY", "Kimi / Moonshot"],
        ["OLLAMA_BASE_URL", "Ollama (local)"],
        ["ELIZAOS_CLOUD_API_KEY", "elizaOS Cloud"],
      ] as const;
      console.log(`${getLogPrefix()} Model providers:`);
      for (const [key, name] of envKeys) {
        const status = process.env[key] ? "configured" : "not set";
        console.log(`  ${name}: ${status}`);
      }
    });
}
