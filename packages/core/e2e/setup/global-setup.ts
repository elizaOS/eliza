/**
 * Playwright global setup: boots a real AgentRuntime with a live LLM provider
 * and exposes it through a lightweight HTTP server on port 13789.
 */
import http from "node:http";
import { v4 as uuidv4 } from "uuid";
import { InMemoryDatabaseAdapter } from "../../src/database/inMemoryAdapter";
import { AgentRuntime } from "../../src/runtime";
import { detectInferenceProviders } from "../../src/testing/inference-provider";
import { createOllamaModelHandlers } from "../../src/testing/ollama-provider";
import type { Character, Memory, Plugin, UUID } from "../../src/types";
import { ChannelType } from "../../src/types";
import { loadEnvFile } from "../../src/utils/environment";

const PORT = 13789;

const TEST_CHARACTER: Character = {
	name: "E2ETestAgent",
	system:
		"You are a concise, helpful assistant used for end-to-end testing. " +
		"Always respond in plain text. Keep answers short (1-3 sentences) unless asked otherwise.",
	bio: ["E2E test agent for Playwright integration tests"],
	templates: {},
	messageExamples: [],
	postExamples: [],
	topics: ["testing"],
	adjectives: ["helpful", "concise"],
	knowledge: [],
	plugins: [],
	secrets: {},
	settings: {},
};

/**
 * Resolve the correct model-provider plugin.
 *
 * IMPORTANT: this runs from `packages/core` inside a nested workspace
 * (`eliza/eliza/...`). Bun's bare-specifier resolution can pick the published
 * `@elizaos/plugin-openai` hoisted at `eliza/node_modules` instead of the
 * local workspace copy under `eliza/plugins/plugin-openai/`. The published
 * 2.0.0-alpha.537 build only forwards `params.prompt`, while the local source
 * also forwards `params.messages` (which the v5 planner relies on). So we
 * resolve the workspace plugins via explicit relative file imports first and
 * fall back to bare-specifier resolution when no local source exists.
 */
async function importWorkspacePlugin(
	relativeFromHere: string,
	bareSpecifier: string,
): Promise<Record<string, unknown> | null> {
	try {
		const mod = (await import(relativeFromHere)) as Record<string, unknown>;
		console.log(
			`[e2e] loaded ${bareSpecifier} from workspace: ${relativeFromHere}`,
		);
		return mod;
	} catch (err) {
		console.warn(
			`[e2e] workspace import failed for ${relativeFromHere}: ${(err as Error).message}; falling back to bare specifier`,
		);
		try {
			const mod = (await import(bareSpecifier)) as Record<string, unknown>;
			console.log(
				`[e2e] loaded ${bareSpecifier} via bare specifier (likely published copy)`,
			);
			return mod;
		} catch {
			return null;
		}
	}
}

async function resolveProviderPlugin(
	providerName: string,
): Promise<Plugin | null> {
	switch (providerName) {
		case "openai": {
			const mod = await importWorkspacePlugin(
				"../../../../plugins/plugin-openai/index.ts",
				"@elizaos/plugin-openai",
			);
			if (!mod) return null;
			return ((mod.openaiPlugin ?? mod.default) as Plugin | undefined) ?? null;
		}
		case "anthropic": {
			const mod = await importWorkspacePlugin(
				"../../../../plugins/plugin-anthropic/index.ts",
				"@elizaos/plugin-anthropic",
			);
			if (!mod) return null;
			return (
				((mod.anthropicPlugin ?? mod.default) as Plugin | undefined) ?? null
			);
		}
		case "groq": {
			const mod = await importWorkspacePlugin(
				"../../../../plugins/plugin-groq/index.ts",
				"@elizaos/plugin-groq",
			);
			if (!mod) return null;
			return ((mod.groqPlugin ?? mod.default) as Plugin | undefined) ?? null;
		}
		case "google": {
			const mod = await importWorkspacePlugin(
				"../../../../plugins/plugin-google-genai/index.ts",
				"@elizaos/plugin-google-genai",
			);
			if (!mod) return null;
			return (mod.default as Plugin | undefined) ?? null;
		}
		default:
			return null;
	}
}

/** Tiny JSON body parser. */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

async function verifyInferenceProvider(runtime: AgentRuntime): Promise<void> {
	await runtime.generateText("Reply with OK.", {
		modelType: "TEXT_LARGE" as "TEXT_LARGE",
		maxTokens: 8,
	});
}

function applyProviderSettings(
	runtime: AgentRuntime,
	providerName: string,
): void {
	switch (providerName) {
		case "openai": {
			const openAiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
			const cerebrasKey = process.env.CEREBRAS_API_KEY?.trim() ?? "";
			const explicitBase = process.env.OPENAI_BASE_URL?.trim();
			const explicitElizaProvider = process.env.ELIZA_PROVIDER?.trim();
			const isCerebras =
				explicitElizaProvider?.toLowerCase() === "cerebras" ||
				/^csk-/i.test(openAiKey || cerebrasKey) ||
				/(^|\.)cerebras\.ai(\/|$)/i.test(explicitBase ?? "");

			runtime.setSetting(
				"OPENAI_API_KEY",
				openAiKey || (isCerebras ? cerebrasKey : ""),
				true,
			);
			if (cerebrasKey) {
				runtime.setSetting("CEREBRAS_API_KEY", cerebrasKey, true);
			}
			if (explicitBase) {
				runtime.setSetting("OPENAI_BASE_URL", explicitBase, true);
			} else if (isCerebras) {
				// Cerebras keys are OpenAI-compatible but must not hit api.openai.com.
				runtime.setSetting(
					"OPENAI_BASE_URL",
					"https://api.cerebras.ai/v1",
					true,
				);
				runtime.setSetting("ELIZA_PROVIDER", "cerebras", true);
			}
			if (explicitElizaProvider) {
				runtime.setSetting("ELIZA_PROVIDER", explicitElizaProvider, true);
			} else if (isCerebras) {
				runtime.setSetting("ELIZA_PROVIDER", "cerebras", true);
			}
			if (isCerebras) {
				const cerebrasModel =
					process.env.OPENAI_LARGE_MODEL?.trim() ||
					process.env.OPENAI_SMALL_MODEL?.trim() ||
					process.env.LARGE_MODEL?.trim() ||
					process.env.SMALL_MODEL?.trim() ||
					"gpt-oss-120b";
				runtime.setSetting(
					"OPENAI_SMALL_MODEL",
					process.env.OPENAI_SMALL_MODEL?.trim() || cerebrasModel,
				);
				runtime.setSetting(
					"OPENAI_LARGE_MODEL",
					process.env.OPENAI_LARGE_MODEL?.trim() || cerebrasModel,
				);
				runtime.setSetting(
					"SMALL_MODEL",
					process.env.SMALL_MODEL?.trim() ||
						process.env.OPENAI_SMALL_MODEL?.trim() ||
						cerebrasModel,
				);
				runtime.setSetting(
					"LARGE_MODEL",
					process.env.LARGE_MODEL?.trim() ||
						process.env.OPENAI_LARGE_MODEL?.trim() ||
						cerebrasModel,
				);
			}
			break;
		}
		case "anthropic":
			runtime.setSetting(
				"ANTHROPIC_API_KEY",
				process.env.ANTHROPIC_API_KEY ?? "",
				true,
			);
			break;
		case "google":
			runtime.setSetting(
				"GOOGLE_GENERATIVE_AI_API_KEY",
				process.env.GOOGLE_API_KEY ??
					process.env.GOOGLE_AI_API_KEY ??
					process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
					"",
				true,
			);
			break;
		case "groq":
			runtime.setSetting("GROQ_API_KEY", process.env.GROQ_API_KEY ?? "", true);
			runtime.setSetting(
				"GROQ_SMALL_MODEL",
				process.env.GROQ_SMALL_MODEL ?? "openai/gpt-oss-120b",
			);
			runtime.setSetting(
				"GROQ_LARGE_MODEL",
				process.env.GROQ_LARGE_MODEL ?? "openai/gpt-oss-120b",
			);
			break;
	}
}

export default async function globalSetup(): Promise<void> {
	process.env.ELIZA_PLAYWRIGHT_E2E = "1";

	// Load repo-local credentials before provider detection so Playwright e2e
	// behaves the same way as the rest of the workspace.
	loadEnvFile();

	// ── 1. Detect inference provider ───────────────────────────────────────
	const detection = await detectInferenceProviders();
	if (!detection.hasProvider || !detection.primaryProvider) {
		console.error(
			"\n[e2e] No inference provider available. Skipping E2E tests.\n" +
				"Set CEREBRAS_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or start Ollama.\n",
		);
		process.env.__E2E_SKIP__ = "1";
		return;
	}

	const provider = detection.primaryProvider;
	console.log(`\n[e2e] Using provider: ${provider.name}\n`);

	// ── 2. Load provider plugin ────────────────────────────────────────────
	const providerPlugin = await resolveProviderPlugin(provider.name);

	// ── 3. Create runtime ──────────────────────────────────────────────────
	const agentId = uuidv4() as UUID;
	const plugins: Plugin[] = [];
	if (providerPlugin) {
		plugins.push(providerPlugin);
	}

	const adapter = new InMemoryDatabaseAdapter(agentId);
	await adapter.init();

	const runtime = new AgentRuntime({
		agentId,
		character: { ...TEST_CHARACTER, id: agentId },
		adapter,
		plugins,
		checkShouldRespond: false, // always respond in tests
		logLevel: "warn",
	});

	applyProviderSettings(runtime, provider.name);

	// For Ollama without a plugin package, register model handlers directly.
	if (provider.name === "ollama" && !providerPlugin) {
		const handlers = createOllamaModelHandlers();
		for (const [modelType, handler] of Object.entries(handlers)) {
			if (handler) {
				runtime.registerModel(
					modelType,
					handler as (
						rt: AgentRuntime,
						p: Record<string, unknown>,
					) => Promise<unknown>,
					"ollama",
				);
			}
		}
	}

	await runtime.initialize();
	console.log("[e2e] Runtime initialized");

	try {
		await verifyInferenceProvider(runtime);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`\n[e2e] Provider preflight failed. Skipping E2E tests.\n${message}\n`,
		);
		process.env.__E2E_SKIP__ = "1";
		await runtime.stop();
		return;
	}

	// ── 4. Prepare a default room & entity for chat ────────────────────────
	const worldId = uuidv4() as UUID;
	await runtime.createWorld({ id: worldId, name: "e2e-world", agentId });
	const roomId = uuidv4() as UUID;
	await runtime.ensureRoomExists({
		id: roomId,
		name: "e2e-chat",
		source: "e2e",
		type: ChannelType.API,
		worldId,
	});
	await runtime.ensureParticipantInRoom(agentId, roomId);

	const testEntityId = uuidv4() as UUID;
	await runtime.createEntity({
		id: testEntityId,
		names: ["E2ETester"],
		agentId,
	});
	await runtime.ensureParticipantInRoom(testEntityId, roomId);

	// ── 5. Start HTTP server ───────────────────────────────────────────────
	const server = http.createServer(async (req, res) => {
		res.setHeader("Content-Type", "application/json");

		try {
			// GET /health
			if (req.method === "GET" && req.url === "/health") {
				res.writeHead(200);
				res.end(JSON.stringify({ ok: true }));
				return;
			}

			// GET /status
			if (req.method === "GET" && req.url === "/status") {
				res.writeHead(200);
				res.end(
					JSON.stringify({
						agentId,
						name: TEST_CHARACTER.name,
						provider: provider.name,
						ready: true,
					}),
				);
				return;
			}

			// POST /chat — drives the FULL agent message pipeline via
			// runtime.messageService.handleMessage so providers, evaluators, and
			// trajectory recording all run. No generateText shortcut here.
			if (req.method === "POST" && req.url === "/chat") {
				const raw = await readBody(req);
				const body = JSON.parse(raw) as {
					text?: string;
					roomId?: string;
					entityId?: string;
				};

				if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
					res.writeHead(400);
					res.end(JSON.stringify({ error: "text is required" }));
					return;
				}

				if (!runtime.messageService) {
					res.writeHead(500);
					res.end(
						JSON.stringify({ error: "messageService unavailable on runtime" }),
					);
					return;
				}

				const chatRoomId = (body.roomId as UUID) ?? roomId;
				const chatEntityId = (body.entityId as UUID) ?? testEntityId;

				const message: Memory = {
					id: uuidv4() as UUID,
					entityId: chatEntityId,
					roomId: chatRoomId,
					content: {
						text: body.text.trim(),
						source: "e2e",
					},
					createdAt: Date.now(),
				};

				let responseText = "";
				const callback = async (content: { text: string }) => {
					if (typeof content?.text === "string") {
						responseText += content.text;
					}
					return [];
				};

				await runtime.messageService.handleMessage(runtime, message, callback);

				res.writeHead(200);
				res.end(
					JSON.stringify({
						text: responseText,
						agentId,
						roomId: chatRoomId,
					}),
				);
				return;
			}

			// fallback
			res.writeHead(404);
			res.end(JSON.stringify({ error: "not found" }));
		} catch (err) {
			console.error("[e2e] Server error:", err);
			res.writeHead(500);
			res.end(
				JSON.stringify({
					error: err instanceof Error ? err.message : "internal error",
				}),
			);
		}
	});

	await new Promise<void>((resolve) => {
		server.listen(PORT, () => {
			console.log(`[e2e] Test server listening on http://localhost:${PORT}`);
			resolve();
		});
	});

	// Store for teardown
	(globalThis as Record<string, unknown>).__e2eServer = server;
	(globalThis as Record<string, unknown>).__e2eRuntime = runtime;
}
