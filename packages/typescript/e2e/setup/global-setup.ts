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

/** Resolve the correct model-provider plugin based on available API keys. */
async function resolveProviderPlugin(
	providerName: string,
): Promise<Plugin | null> {
	switch (providerName) {
		case "openai": {
			const mod = await import("@elizaos/plugin-openai");
			return mod.openaiPlugin ?? mod.default ?? null;
		}
		case "anthropic": {
			const mod = await import("@elizaos/plugin-anthropic");
			return mod.anthropicPlugin ?? mod.default ?? null;
		}
		case "groq": {
			const mod = await import("@elizaos/plugin-groq");
			return mod.groqPlugin ?? mod.default ?? null;
		}
		case "google": {
			try {
				const mod = await import("@elizaos/plugin-google-genai");
				return mod.default ?? null;
			} catch {
				return null;
			}
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
		case "openai":
			runtime.setSetting(
				"OPENAI_API_KEY",
				process.env.OPENAI_API_KEY ?? "",
				true,
			);
			break;
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
				process.env.GROQ_SMALL_MODEL ?? "llama-3.1-8b-instant",
			);
			runtime.setSetting(
				"GROQ_LARGE_MODEL",
				process.env.GROQ_LARGE_MODEL ?? "llama-3.3-70b-versatile",
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
				"Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or start Ollama.\n",
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

			// POST /chat
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

				const chatRoomId = (body.roomId as UUID) ?? roomId;

				// Use generateText for a reliable, simpler path than full messageService
				const result = await runtime.generateText(body.text.trim(), {
					modelType: "TEXT_LARGE" as "TEXT_LARGE",
					maxTokens: 1024,
				});

				res.writeHead(200);
				res.end(
					JSON.stringify({
						text: result.text,
						agentId,
						roomId: chatRoomId,
					}),
				);
				return;
			}

			// POST /chat/full  (full message pipeline via messageService)
			if (req.method === "POST" && req.url === "/chat/full") {
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
					responseText += content.text;
					return [];
				};

				if (runtime.messageService) {
					await runtime.messageService.handleMessage(
						runtime,
						message,
						callback,
					);
				}

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
