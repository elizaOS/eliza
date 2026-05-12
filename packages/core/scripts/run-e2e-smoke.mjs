import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const truthyValues = new Set(["1", "true", "yes", "on"]);
const specPath = path.join(packageRoot, "e2e", "runtime-live.e2e.spec.ts");
const defaultOllamaUrls = ["http://127.0.0.1:11434", "http://localhost:11434"];

function envFlagEnabled(name) {
	const value = process.env[name]?.trim().toLowerCase();
	return value ? truthyValues.has(value) : false;
}

function getConfiguredProviderUrl() {
	return process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || null;
}

async function canReachOllama(baseUrl) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1000);

	try {
		const response = await fetch(`${baseUrl}/api/tags`, {
			signal: controller.signal,
		});
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function resolveProviderEnv() {
	if (
		process.env.OPENAI_API_KEY ||
		process.env.ANTHROPIC_API_KEY ||
		process.env.GROQ_API_KEY ||
		process.env.OPENROUTER_API_KEY ||
		process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
		process.env.GEMINI_API_KEY ||
		process.env.GOOGLE_API_KEY
	) {
		return {};
	}

	const configuredOllamaUrl = getConfiguredProviderUrl();
	if (configuredOllamaUrl) {
		return {
			OLLAMA_BASE_URL: configuredOllamaUrl,
			OLLAMA_HOST: configuredOllamaUrl,
			OLLAMA_URL: configuredOllamaUrl,
		};
	}

	for (const url of defaultOllamaUrls) {
		if (await canReachOllama(url)) {
			return {
				OLLAMA_BASE_URL: url,
				OLLAMA_HOST: url,
				OLLAMA_URL: url,
			};
		}
	}

	return null;
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

const providerEnv = await resolveProviderEnv();

if (!providerEnv) {
	skip("no live inference provider is configured");
}

const bunCommand = process.env.npm_execpath || process.env.BUN || "bun";
const result = spawnSync(
	bunCommand,
	["x", "playwright", "test", "e2e/runtime-live.e2e.spec.ts"],
	{
		cwd: packageRoot,
		stdio: "inherit",
		env: {
			...process.env,
			...providerEnv,
		},
	},
);

if (result.error?.code === "ENOENT") {
	skip(`the Playwright runner could not be launched: ${result.error.message}`);
}

process.exit(result.status ?? 1);
