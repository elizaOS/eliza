#!/usr/bin/env node
/**
 * patch-plugin-ollama-chat.mjs
 *
 * Same root issue as patch-plugin-ollama-embeddings: monorepo uses ai@6, while
 * ollama-ai-provider exposes spec v1. `generateText` / `generateObject` from ai@6
 * reject ollama.chat / ollama.completion ("Unsupported model version v1").
 *
 * Use Ollama's native POST /api/chat (stream: false) for text and object generation.
 *
 * Idempotent: skips if already patched.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const OLD_IMPORTS = `import { ModelType, logger } from "@elizaos/core";
import { generateObject, generateText } from "ai";
import { createOllama } from "ollama-ai-provider";`;

const NEW_IMPORTS = `import { ModelType, logger } from "@elizaos/core";`;

const OLD_GENERATORS = `async function generateOllamaText(ollama, model, params) {
  try {
    const { text: ollamaResponse } = await generateText({
      model: ollama(model),
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      frequencyPenalty: params.frequencyPenalty,
      presencePenalty: params.presencePenalty,
      stopSequences: params.stopSequences
    });
    return ollamaResponse;
  } catch (error) {
    logger.error({ error }, "Error in generateOllamaText");
    return "Error generating text. Please try again later.";
  }
}
async function generateOllamaObject(ollama, model, params) {
  try {
    const { object } = await generateObject({
      model: ollama(model),
      output: "no-schema",
      prompt: params.prompt,
      temperature: params.temperature
    });
    return object;
  } catch (error) {
    logger.error({ error }, "Error generating object");
    return {};
  }
}`;

const NEW_GENERATORS = `async function generateOllamaText(runtime, baseURL, model, params) {
  try {
    const apiBase = baseURL.endsWith("/api") ? baseURL.slice(0, -4) : baseURL;
    const messages = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.prompt });
    const options = {};
    if (params.temperature !== void 0) options.temperature = params.temperature;
    if (params.maxTokens !== void 0) options.num_predict = params.maxTokens;
    if (params.frequencyPenalty !== void 0) options.frequency_penalty = params.frequencyPenalty;
    if (params.presencePenalty !== void 0) options.presence_penalty = params.presencePenalty;
    if (params.stopSequences && params.stopSequences.length) options.stop = params.stopSequences;
    const body = { model, messages, stream: false, options };
    const res = await (runtime.fetch ?? fetch)(\`\${apiBase}/api/chat\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(\`Ollama chat HTTP \${res.status}: \${errText}\`);
    }
    const data = await res.json();
    const text = data?.message?.content;
    return typeof text === "string" ? text : "";
  } catch (error) {
    logger.error({ error }, "Error in generateOllamaText");
    return "Error generating text. Please try again later.";
  }
}
async function generateOllamaObject(runtime, baseURL, model, params) {
  try {
    const text = await generateOllamaText(runtime, baseURL, model, {
      prompt: params.prompt,
      system: void 0,
      temperature: params.temperature,
      maxTokens: params.maxTokens ?? 8192,
      frequencyPenalty: params.frequencyPenalty,
      presencePenalty: params.presencePenalty,
      stopSequences: params.stopSequences ?? []
    });
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          return {};
        }
      }
      return {};
    }
  } catch (error) {
    logger.error({ error }, "Error generating object");
    return {};
  }
}`;

const OLD_TEXT_SMALL = `    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }) => {
      try {
        const temperature = 0.7;
        const frequency_penalty = 0.7;
        const presence_penalty = 0.7;
        const max_response_length = 8e3;
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL
        });
        const model = runtime.getSetting("OLLAMA_SMALL_MODEL") || runtime.getSetting("SMALL_MODEL") || "gemma3:latest";
        logger.log(\`[Ollama] Using TEXT_SMALL model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        logger.log("generating text");
        logger.log(prompt);
        return await generateOllamaText(ollama, model, {
          prompt,
          system: runtime.character?.system || void 0,
          temperature,
          maxTokens: max_response_length,
          frequencyPenalty: frequency_penalty,
          presencePenalty: presence_penalty,
          stopSequences
        });
      } catch (error) {
        logger.error({ error }, "Error in TEXT_SMALL model");
        return "Error generating text. Please try again later.";
      }
    },`;

const NEW_TEXT_SMALL = `    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }) => {
      try {
        const temperature = 0.7;
        const frequency_penalty = 0.7;
        const presence_penalty = 0.7;
        const max_response_length = 8e3;
        const baseURL = getBaseURL(runtime);
        const model = runtime.getSetting("OLLAMA_SMALL_MODEL") || runtime.getSetting("SMALL_MODEL") || "gemma3:latest";
        logger.log(\`[Ollama] Using TEXT_SMALL model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        logger.log("generating text");
        logger.log(prompt);
        return await generateOllamaText(runtime, baseURL, model, {
          prompt,
          system: runtime.character?.system || void 0,
          temperature,
          maxTokens: max_response_length,
          frequencyPenalty: frequency_penalty,
          presencePenalty: presence_penalty,
          stopSequences
        });
      } catch (error) {
        logger.error({ error }, "Error in TEXT_SMALL model");
        return "Error generating text. Please try again later.";
      }
    },`;

const OLD_TEXT_LARGE = `    [ModelType.TEXT_LARGE]: async (runtime, {
      prompt,
      stopSequences = [],
      maxTokens = 8192,
      temperature = 0.7,
      frequencyPenalty = 0.7,
      presencePenalty = 0.7
    }) => {
      try {
        const model = runtime.getSetting("OLLAMA_LARGE_MODEL") || runtime.getSetting("LARGE_MODEL") || "gemma3:latest";
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL
        });
        logger.log(\`[Ollama] Using TEXT_LARGE model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        return await generateOllamaText(ollama, model, {
          prompt,
          system: runtime.character?.system || void 0,
          temperature,
          maxTokens,
          frequencyPenalty,
          presencePenalty,
          stopSequences
        });
      } catch (error) {
        logger.error({ error }, "Error in TEXT_LARGE model");
        return "Error generating text. Please try again later.";
      }
    },`;

const NEW_TEXT_LARGE = `    [ModelType.TEXT_LARGE]: async (runtime, {
      prompt,
      stopSequences = [],
      maxTokens = 8192,
      temperature = 0.7,
      frequencyPenalty = 0.7,
      presencePenalty = 0.7
    }) => {
      try {
        const model = runtime.getSetting("OLLAMA_LARGE_MODEL") || runtime.getSetting("LARGE_MODEL") || "gemma3:latest";
        const baseURL = getBaseURL(runtime);
        logger.log(\`[Ollama] Using TEXT_LARGE model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        return await generateOllamaText(runtime, baseURL, model, {
          prompt,
          system: runtime.character?.system || void 0,
          temperature,
          maxTokens,
          frequencyPenalty,
          presencePenalty,
          stopSequences
        });
      } catch (error) {
        logger.error({ error }, "Error in TEXT_LARGE model");
        return "Error generating text. Please try again later.";
      }
    },`;

const OLD_OBJECT_SMALL = `    [ModelType.OBJECT_SMALL]: async (runtime, params) => {
      try {
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL
        });
        const model = runtime.getSetting("OLLAMA_SMALL_MODEL") || runtime.getSetting("SMALL_MODEL") || "gemma3:latest";
        logger.log(\`[Ollama] Using OBJECT_SMALL model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        if (params.schema) {
          logger.info("Using OBJECT_SMALL without schema validation");
        }
        return await generateOllamaObject(ollama, model, params);
      } catch (error) {
        logger.error({ error }, "Error in OBJECT_SMALL model");
        return {};
      }
    },`;

const NEW_OBJECT_SMALL = `    [ModelType.OBJECT_SMALL]: async (runtime, params) => {
      try {
        const baseURL = getBaseURL(runtime);
        const model = runtime.getSetting("OLLAMA_SMALL_MODEL") || runtime.getSetting("SMALL_MODEL") || "gemma3:latest";
        logger.log(\`[Ollama] Using OBJECT_SMALL model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        if (params.schema) {
          logger.info("Using OBJECT_SMALL without schema validation");
        }
        return await generateOllamaObject(runtime, baseURL, model, params);
      } catch (error) {
        logger.error({ error }, "Error in OBJECT_SMALL model");
        return {};
      }
    },`;

const OLD_OBJECT_LARGE = `    [ModelType.OBJECT_LARGE]: async (runtime, params) => {
      try {
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL
        });
        const model = runtime.getSetting("OLLAMA_LARGE_MODEL") || runtime.getSetting("LARGE_MODEL") || "gemma3:latest";
        logger.log(\`[Ollama] Using OBJECT_LARGE model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        if (params.schema) {
          logger.info("Using OBJECT_LARGE without schema validation");
        }
        return await generateOllamaObject(ollama, model, params);
      } catch (error) {
        logger.error({ error }, "Error in OBJECT_LARGE model");
        return {};
      }
    },`;

const NEW_OBJECT_LARGE = `    [ModelType.OBJECT_LARGE]: async (runtime, params) => {
      try {
        const baseURL = getBaseURL(runtime);
        const model = runtime.getSetting("OLLAMA_LARGE_MODEL") || runtime.getSetting("LARGE_MODEL") || "gemma3:latest";
        logger.log(\`[Ollama] Using OBJECT_LARGE model: \${model}\`);
        await ensureModelAvailable(runtime, model, baseURL);
        if (params.schema) {
          logger.info("Using OBJECT_LARGE without schema validation");
        }
        return await generateOllamaObject(runtime, baseURL, model, params);
      } catch (error) {
        logger.error({ error }, "Error in OBJECT_LARGE model");
        return {};
      }
    },`;

function patchFile(filePath) {
	if (!existsSync(filePath)) return false;
	let s = readFileSync(filePath, "utf8");
	if (
		s.includes("generateOllamaText(runtime, baseURL") &&
		!s.includes("await generateText(")
	) {
		return false;
	}
	if (!s.includes("async function generateOllamaText(ollama, model, params)")) {
		console.warn(`[patch-plugin-ollama-chat] Unrecognized format at ${filePath} — skipping`);
		return false;
	}
	s = s.replace(OLD_IMPORTS, NEW_IMPORTS);
	s = s.replace(OLD_GENERATORS, NEW_GENERATORS);
	s = s.replace(OLD_TEXT_SMALL, NEW_TEXT_SMALL);
	s = s.replace(OLD_TEXT_LARGE, NEW_TEXT_LARGE);
	s = s.replace(OLD_OBJECT_SMALL, NEW_OBJECT_SMALL);
	s = s.replace(OLD_OBJECT_LARGE, NEW_OBJECT_LARGE);
	writeFileSync(filePath, s);
	console.log(`[patch-plugin-ollama-chat] Patched ${filePath}`);
	return true;
}

function walkBunPluginOllama() {
	const bunDir = join(repoRoot, "node_modules", ".bun");
	if (!existsSync(bunDir)) return;
	for (const entry of readdirSync(bunDir)) {
		if (!entry.startsWith("@elizaos+plugin-ollama@")) continue;
		const candidate = join(
			bunDir,
			entry,
			"node_modules",
			"@elizaos",
			"plugin-ollama",
			"dist",
			"index.js",
		);
		patchFile(candidate);
	}
}

patchFile(join(repoRoot, "agent", "node_modules", "@elizaos", "plugin-ollama", "dist", "index.js"));
patchFile(join(repoRoot, "node_modules", "@elizaos", "plugin-ollama", "dist", "index.js"));
walkBunPluginOllama();
