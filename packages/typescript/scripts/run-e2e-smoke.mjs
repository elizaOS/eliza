import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const truthyValues = new Set(["1", "true", "yes", "on"]);
const specPath = path.join(packageRoot, "e2e", "runtime-live.e2e.spec.ts");

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? truthyValues.has(value) : false;
}

function hasProviderConfig() {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.OLLAMA_HOST ||
      process.env.OLLAMA_BASE_URL,
  );
}

function skip(reason) {
  console.log(`[eliza/typescript] Skipping e2e smoke because ${reason}.`);
  process.exit(0);
}

if (envFlagEnabled("ELIZA_SKIP_ELIZA_LIVE_SMOKE")) {
  skip("ELIZA_SKIP_ELIZA_LIVE_SMOKE=1");
}

if (!fs.existsSync(specPath)) {
  skip("the runtime live e2e spec is not available in this checkout");
}

if (!hasProviderConfig()) {
  skip("no live inference provider is configured");
}

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  npxCommand,
  ["playwright", "test", "e2e/runtime-live.e2e.spec.ts"],
  {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error?.code === "ENOENT") {
  skip(`the Playwright runner could not be launched: ${result.error.message}`);
}

process.exit(result.status ?? 1);
