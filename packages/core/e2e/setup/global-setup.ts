/**
 * Playwright global setup: boots a real AgentRuntime with a live LLM provider
 * and exposes it through a lightweight HTTP server on a kernel-assigned port,
 * advertised to workers via the CORE_E2E_BASE_URL environment variable (the
 * same runner-to-worker env channel as __E2E_SKIP__). A fixed port collides
 * when CI fan-out places concurrent jobs on one runner host (#18359).
 */

import { randomUUID as uuidv4 } from "node:crypto";
import http from "node:http";
import {
	AgentRuntime,
	ChannelType,
	type Character,
	type HandlerCallback,
	type Memory,
	type Plugin,
	type UUID,
} from "@elizaos/core";
import { createAssistantPlugin } from "../../../../plugins/plugin-assistant/src/index.ts";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "../../../host/src/contracts/service-routing.ts";
import {
	createOllamaModelHandlers,
	detectInferenceProviders,
	SQLiteDatabaseAdapter,
} from "../../../testing/src/runtime.ts";
import { loadEnvFile } from "./env";

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
/** Loads the workspace source of the detected provider's model plugin. */
async function resolveProviderPlugin(
	providerName: string,
): Promise<Plugin | null> {
	switch (providerName) {
		case "openai":
			return (await import("../../../../plugins/plugin-openai/index.ts"))
				.openaiPlugin;
		case "anthropic":
			return (await import("../../../../plugins/plugin-anthropic/index.ts"))
				.anthropicPlugin;
		case "ollama":
			return null;
		default:
			throw new Error(
				`[e2e] No workspace model plugin for provider "${providerName}"`,
			);
	}
}
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
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
					DEFAULT_CEREBRAS_TEXT_MODEL;
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
	const plugins: Plugin[] = [createAssistantPlugin()];
	if (providerPlugin) {
		plugins.push(providerPlugin);
	}
	const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
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
	// Ollama has no workspace plugin; register its model handlers directly.
	if (provider.name === "ollama") {
		const handlers = createOllamaModelHandlers();
		for (const [modelType, handler] of Object.entries(handlers)) {
			if (handler) {
				runtime.registerModel(
					modelType,
					handler as Parameters<AgentRuntime["registerModel"]>[1],
					"ollama",
				);
			}
		}
	}
	await runtime.initialize();
	console.log("[e2e] Runtime initialized");
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
				const callback: HandlerCallback = async (content) => {
					if (typeof content.text === "string") responseText += content.text;
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
	// Bind port 0 so the kernel assigns a free port at bind time; the socket is
	// never probed and released, so concurrent suites cannot steal it (#18359).
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error(`[e2e] test server bound no TCP address: ${address}`);
	}
	const baseURL = `http://127.0.0.1:${address.port}`;
	// Workers spawn after global setup and inherit this env; playwright.config
	// re-evaluates in each worker and reads it as `use.baseURL`.
	process.env.CORE_E2E_BASE_URL = baseURL;
	console.log(`[e2e] Test server listening on ${baseURL}`);
	// Store for teardown
	(globalThis as Record<string, unknown>).__e2eServer = server;
	(globalThis as Record<string, unknown>).__e2eRuntime = runtime;
}
