#!/usr/bin/env node
/**
 * patch-plugin-ollama-embeddings.mjs
 *
 * The repo overrides `ai` to 6.x; @elizaos/plugin-ollama 1.2.x uses ollama-ai-provider
 * (embedding spec v1). `embed()` from ai@6 rejects v1 models ("Unsupported model version v1").
 *
 * Call Ollama's HTTP `/api/embeddings` directly instead of Vercel `embed()`, matching
 * https://github.com/ollama/ollama/blob/main/docs/api.md#generate-embeddings
 *
 * Idempotent: skips if already patched.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const OLD_IMPORT = 'import { generateObject, generateText, embed } from "ai";';
const NEW_IMPORT = 'import { generateObject, generateText } from "ai";';

const OLD_EMBED_BLOCK = `        try {
          const { embedding } = await embed({
            model: ollama.embedding(modelName),
            value: embeddingText
          });
          return embedding;`;

const NEW_EMBED_BLOCK = `        try {
          const apiBase = baseURL.endsWith("/api") ? baseURL.slice(0, -4) : baseURL;
          const embedRes = await (runtime.fetch ?? fetch)(\`\${apiBase}/api/embeddings\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: modelName, prompt: embeddingText })
          });
          if (!embedRes.ok) {
            const errText = await embedRes.text();
            throw new Error(\`Ollama embeddings HTTP \${embedRes.status}: \${errText}\`);
          }
          const data = await embedRes.json();
          const embedding = data.embedding;
          if (!Array.isArray(embedding)) {
            throw new Error("Ollama embeddings response missing embedding array");
          }
          return embedding;`;

const OLD_OLLAMA_CREATE = `        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL
        });
        const modelName = runtime.getSetting("OLLAMA_EMBEDDING_MODEL")`;

const NEW_OLLAMA_CREATE = `        const baseURL = getBaseURL(runtime);
        const modelName = runtime.getSetting("OLLAMA_EMBEDDING_MODEL")`;

function patchFile(filePath) {
	if (!existsSync(filePath)) return false;
	let s = readFileSync(filePath, "utf8");
	if (!s.includes(OLD_EMBED_BLOCK)) {
		return false;
	}
	if (s.includes(OLD_IMPORT)) {
		s = s.replace(OLD_IMPORT, NEW_IMPORT);
	}
	if (s.includes(OLD_OLLAMA_CREATE)) {
		s = s.replace(OLD_OLLAMA_CREATE, NEW_OLLAMA_CREATE);
	}
	s = s.replace(OLD_EMBED_BLOCK, NEW_EMBED_BLOCK);
	writeFileSync(filePath, s);
	console.log(`[patch-plugin-ollama-embeddings] Patched ${filePath}`);
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
