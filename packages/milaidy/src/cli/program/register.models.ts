import type { Command } from "commander";

export function registerModelsCli(program: Command) {
  program
    .command("models")
    .description("Show configured model providers")
    .action(() => {
      const envKeys = [
        ["ANTHROPIC_API_KEY", "Anthropic (Claude)"],
        ["OPENAI_API_KEY", "OpenAI (GPT)"],
        ["GOOGLE_API_KEY", "Google (Gemini)"],
        ["GROQ_API_KEY", "Groq"],
        ["XAI_API_KEY", "xAI (Grok)"],
        ["OPENROUTER_API_KEY", "OpenRouter"],
        ["OLLAMA_BASE_URL", "Ollama (local)"],
      ] as const;
      console.log("[milaidy] Model providers:");
      for (const [key, name] of envKeys) {
        const status = process.env[key] ? "configured" : "not set";
        console.log(`  ${name}: ${status}`);
      }
    });
}
