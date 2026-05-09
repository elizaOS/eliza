/**
 * Reusable harness for live e2e tests that boot a real `AgentRuntime` against a
 * live LLM provider (default: OpenAI plugin wired to Cerebras) and drive the
 * full message pipeline through `messageService.handleMessage`.
 *
 * Skip-with-warning behavior:
 *   When a required env var is missing, `describeLive` registers a single
 *   skipped test whose name explains what to set, sets `SKIP_REASON` so
 *   `fail-on-silent-skip.setup.ts` does not trip, and emits a yellow warning
 *   to the console. The workflow does not fail when keys are absent.
 *
 * The InMemoryDatabaseAdapter + provider-plugin import patterns are lifted
 * from `packages/core/e2e/setup/global-setup.ts`. The Cerebras alias mirrors
 * the logic in `scripts/test-env.mjs`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
	AgentRuntime,
	ChannelType,
	type Character,
	InMemoryDatabaseAdapter,
	type Memory,
	type Plugin,
	type UUID,
} from "@elizaos/core";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export type LiveProviderId =
	| "openai"
	| "anthropic"
	| "google"
	| "groq"
	| "openrouter"
	| "ollama"
	| "xai"
	| "nvidiacloud"
	| "elizacloud"
	| "cerebras";

export interface LiveAgentTestOptions {
	/** Required env vars. If any is missing, the suite skips with a warning. */
	requiredEnv: string[];
	/** Provider plugin id (e.g. "openai"). Defaults to "openai" + Cerebras. */
	provider?: LiveProviderId;
	/** Character system prompt override. */
	systemPrompt?: string;
	/** Plugins to load in addition to the provider plugin. Workspace path or bare specifier. */
	extraPlugins?: Array<string | { path: string; name?: string }>;
}

export interface LiveAgentHarness {
	agentId: string;
	runtime: AgentRuntime;
	/** Sends a chat message through messageService.handleMessage and returns the assistant reply text. */
	runAgentTurn(text: string): Promise<string>;
	/** Stop the runtime and clean up. */
	close(): Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT =
	"You are a concise, helpful assistant used for end-to-end testing. " +
	"Always respond in plain text. Keep answers short (1-3 sentences) unless asked otherwise.";

interface ProviderConfig {
	pluginPath: string;
	bareSpecifier: string;
	pluginExportNames: string[];
	defaultRequiredEnv: string[];
}

const PROVIDER_CONFIG: Record<LiveProviderId, ProviderConfig> = {
	openai: {
		pluginPath: "../../../../plugins/plugin-openai/index.ts",
		bareSpecifier: "@elizaos/plugin-openai",
		pluginExportNames: ["openaiPlugin", "default"],
		defaultRequiredEnv: ["OPENAI_API_KEY"],
	},
	anthropic: {
		pluginPath: "../../../../plugins/plugin-anthropic/index.ts",
		bareSpecifier: "@elizaos/plugin-anthropic",
		pluginExportNames: ["anthropicPlugin", "default"],
		defaultRequiredEnv: ["ANTHROPIC_API_KEY"],
	},
	google: {
		pluginPath: "../../../../plugins/plugin-google-genai/index.ts",
		bareSpecifier: "@elizaos/plugin-google-genai",
		pluginExportNames: ["default"],
		defaultRequiredEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"],
	},
	groq: {
		pluginPath: "../../../../plugins/plugin-groq/index.ts",
		bareSpecifier: "@elizaos/plugin-groq",
		pluginExportNames: ["groqPlugin", "default"],
		defaultRequiredEnv: ["GROQ_API_KEY"],
	},
	openrouter: {
		pluginPath: "../../../../plugins/plugin-openrouter/index.ts",
		bareSpecifier: "@elizaos/plugin-openrouter",
		pluginExportNames: ["openrouterPlugin", "default"],
		defaultRequiredEnv: ["OPENROUTER_API_KEY"],
	},
	ollama: {
		pluginPath: "../../../../plugins/plugin-ollama/index.ts",
		bareSpecifier: "@elizaos/plugin-ollama",
		pluginExportNames: ["ollamaPlugin", "default"],
		defaultRequiredEnv: ["OLLAMA_API_ENDPOINT"],
	},
	xai: {
		pluginPath: "../../../../plugins/plugin-xai/index.ts",
		bareSpecifier: "@elizaos/plugin-xai",
		pluginExportNames: ["XAIPlugin", "default"],
		defaultRequiredEnv: ["XAI_API_KEY"],
	},
	nvidiacloud: {
		pluginPath: "../../../../plugins/plugin-nvidiacloud/dist/index.js",
		bareSpecifier: "@elizaos/plugin-nvidiacloud",
		pluginExportNames: ["nvidiaCloudPlugin", "default"],
		defaultRequiredEnv: ["NVIDIA_API_KEY"],
	},
	elizacloud: {
		pluginPath: "../../../../plugins/plugin-elizacloud/src/index.ts",
		bareSpecifier: "@elizaos/plugin-elizacloud",
		pluginExportNames: ["elizaOSCloudPlugin", "default"],
		defaultRequiredEnv: ["ELIZAOS_CLOUD_API_KEY"],
	},
	// Cerebras is an alias for the openai plugin pre-configured to talk to
	// the Cerebras OpenAI-compatible endpoint. Useful for tests that explicitly
	// want Cerebras even when OPENAI_API_KEY is set to a real OpenAI key.
	cerebras: {
		pluginPath: "../../../../plugins/plugin-openai/index.ts",
		bareSpecifier: "@elizaos/plugin-openai",
		pluginExportNames: ["openaiPlugin", "default"],
		defaultRequiredEnv: ["CEREBRAS_API_KEY"],
	},
};

/**
 * Resolve the workspace plugin via explicit relative file import first, falling
 * back to the bare specifier (which may point at a published copy hoisted in
 * `node_modules`). Same pattern as `packages/core/e2e/setup/global-setup.ts`.
 */
async function importWorkspacePlugin(
	relativeFromHere: string,
	bareSpecifier: string,
): Promise<Record<string, unknown> | null> {
	try {
		const mod = (await import(relativeFromHere)) as Record<string, unknown>;
		return mod;
	} catch {
		try {
			const mod = (await import(bareSpecifier)) as Record<string, unknown>;
			return mod;
		} catch {
			return null;
		}
	}
}

async function resolveProviderPlugin(
	provider: LiveProviderId,
): Promise<Plugin | null> {
	const cfg = PROVIDER_CONFIG[provider];
	const mod = await importWorkspacePlugin(cfg.pluginPath, cfg.bareSpecifier);
	if (!mod) return null;
	for (const name of cfg.pluginExportNames) {
		const candidate = mod[name];
		if (candidate) return candidate as Plugin;
	}
	return null;
}

async function loadExtraPlugin(
	entry: string | { path: string; name?: string },
): Promise<Plugin | null> {
	const path = typeof entry === "string" ? entry : entry.path;
	const named = typeof entry === "string" ? undefined : entry.name;
	try {
		const mod = (await import(path)) as Record<string, unknown>;
		const candidate = named ? mod[named] : (mod.default ?? Object.values(mod)[0]);
		return (candidate as Plugin | undefined) ?? null;
	} catch {
		return null;
	}
}

function applyProviderSettings(
	runtime: AgentRuntime,
	provider: LiveProviderId,
): void {
	switch (provider) {
		case "openai":
			runtime.setSetting(
				"OPENAI_API_KEY",
				process.env.OPENAI_API_KEY ?? "",
				true,
			);
			if (process.env.OPENAI_BASE_URL) {
				runtime.setSetting("OPENAI_BASE_URL", process.env.OPENAI_BASE_URL);
			}
			if (process.env.OPENAI_LARGE_MODEL) {
				runtime.setSetting("OPENAI_LARGE_MODEL", process.env.OPENAI_LARGE_MODEL);
			}
			if (process.env.OPENAI_MEDIUM_MODEL) {
				runtime.setSetting("OPENAI_MEDIUM_MODEL", process.env.OPENAI_MEDIUM_MODEL);
			}
			if (process.env.OPENAI_SMALL_MODEL) {
				runtime.setSetting("OPENAI_SMALL_MODEL", process.env.OPENAI_SMALL_MODEL);
			}
			if (process.env.OPENAI_ACTION_PLANNER_MODEL) {
				runtime.setSetting(
					"OPENAI_ACTION_PLANNER_MODEL",
					process.env.OPENAI_ACTION_PLANNER_MODEL,
				);
			}
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
				process.env.GROQ_SMALL_MODEL ?? "openai/gpt-oss-20b",
			);
			runtime.setSetting(
				"GROQ_LARGE_MODEL",
				process.env.GROQ_LARGE_MODEL ?? "openai/gpt-oss-120b",
			);
			break;
		case "openrouter":
			runtime.setSetting(
				"OPENROUTER_API_KEY",
				process.env.OPENROUTER_API_KEY ?? "",
				true,
			);
			break;
		case "ollama": {
			const endpoint =
				process.env.OLLAMA_API_ENDPOINT?.trim() ||
				process.env.OLLAMA_API_URL?.trim() ||
				"";
			runtime.setSetting("OLLAMA_API_ENDPOINT", endpoint, true);
			if (process.env.OLLAMA_SMALL_MODEL) {
				runtime.setSetting(
					"OLLAMA_SMALL_MODEL",
					process.env.OLLAMA_SMALL_MODEL,
				);
			}
			if (process.env.OLLAMA_LARGE_MODEL) {
				runtime.setSetting(
					"OLLAMA_LARGE_MODEL",
					process.env.OLLAMA_LARGE_MODEL,
				);
			}
			if (process.env.OLLAMA_EMBEDDING_MODEL) {
				runtime.setSetting(
					"OLLAMA_EMBEDDING_MODEL",
					process.env.OLLAMA_EMBEDDING_MODEL,
				);
			}
			break;
		}
		case "xai":
			runtime.setSetting("XAI_API_KEY", process.env.XAI_API_KEY ?? "", true);
			if (process.env.XAI_BASE_URL) {
				runtime.setSetting("XAI_BASE_URL", process.env.XAI_BASE_URL);
			}
			if (process.env.XAI_LARGE_MODEL) {
				runtime.setSetting("XAI_LARGE_MODEL", process.env.XAI_LARGE_MODEL);
			}
			if (process.env.XAI_SMALL_MODEL) {
				runtime.setSetting("XAI_SMALL_MODEL", process.env.XAI_SMALL_MODEL);
			}
			break;
		case "nvidiacloud":
			runtime.setSetting(
				"NVIDIA_API_KEY",
				process.env.NVIDIA_API_KEY ?? process.env.NVIDIA_CLOUD_API_KEY ?? "",
				true,
			);
			if (process.env.NVIDIA_BASE_URL) {
				runtime.setSetting("NVIDIA_BASE_URL", process.env.NVIDIA_BASE_URL);
			}
			if (process.env.NVIDIA_LARGE_MODEL) {
				runtime.setSetting(
					"NVIDIA_LARGE_MODEL",
					process.env.NVIDIA_LARGE_MODEL,
				);
			}
			if (process.env.NVIDIA_SMALL_MODEL) {
				runtime.setSetting(
					"NVIDIA_SMALL_MODEL",
					process.env.NVIDIA_SMALL_MODEL,
				);
			}
			break;
		case "elizacloud":
			runtime.setSetting(
				"ELIZAOS_CLOUD_API_KEY",
				process.env.ELIZAOS_CLOUD_API_KEY ?? "",
				true,
			);
			if (process.env.ELIZAOS_CLOUD_BASE_URL) {
				runtime.setSetting(
					"ELIZAOS_CLOUD_BASE_URL",
					process.env.ELIZAOS_CLOUD_BASE_URL,
				);
			}
			if (process.env.ELIZAOS_CLOUD_LARGE_MODEL) {
				runtime.setSetting(
					"ELIZAOS_CLOUD_LARGE_MODEL",
					process.env.ELIZAOS_CLOUD_LARGE_MODEL,
				);
			}
			if (process.env.ELIZAOS_CLOUD_SMALL_MODEL) {
				runtime.setSetting(
					"ELIZAOS_CLOUD_SMALL_MODEL",
					process.env.ELIZAOS_CLOUD_SMALL_MODEL,
				);
			}
			break;
		case "cerebras": {
			// Cerebras = OpenAI plugin pinned at the Cerebras endpoint. Pick the
			// dedicated key first; fall back to OPENAI_API_KEY if a caller is
			// already aliasing it themselves.
			const key =
				process.env.CEREBRAS_API_KEY?.trim() ||
				process.env.OPENAI_API_KEY?.trim() ||
				"";
			runtime.setSetting("OPENAI_API_KEY", key, true);
			runtime.setSetting(
				"OPENAI_BASE_URL",
				process.env.OPENAI_BASE_URL || "https://api.cerebras.ai/v1",
			);
			runtime.setSetting(
				"OPENAI_LARGE_MODEL",
				process.env.OPENAI_LARGE_MODEL || "gpt-oss-120b",
			);
			runtime.setSetting(
				"OPENAI_MEDIUM_MODEL",
				process.env.OPENAI_MEDIUM_MODEL ||
					process.env.OPENAI_LARGE_MODEL ||
					"gpt-oss-120b",
			);
			runtime.setSetting(
				"OPENAI_SMALL_MODEL",
				process.env.OPENAI_SMALL_MODEL || "gpt-oss-120b",
			);
			runtime.setSetting(
				"OPENAI_ACTION_PLANNER_MODEL",
				process.env.OPENAI_ACTION_PLANNER_MODEL ||
					process.env.OPENAI_LARGE_MODEL ||
					"gpt-oss-120b",
			);
			runtime.setSetting(
				"OPENAI_PLANNER_MODEL",
				process.env.OPENAI_PLANNER_MODEL ||
					process.env.OPENAI_ACTION_PLANNER_MODEL ||
					process.env.OPENAI_LARGE_MODEL ||
					"gpt-oss-120b",
			);
			break;
		}
	}
}

/**
 * Apply the Cerebras alias for OpenAI-provider live tests. Mirrors the logic
 * in `scripts/test-env.mjs`: when CEREBRAS_API_KEY is present and OPENAI_API_KEY
 * isn't, populate OPENAI_* env vars so plugin-openai talks to Cerebras.
 *
 * Returns a disposer that restores the previous values.
 */
function maybeApplyCerebrasAlias(provider: LiveProviderId): () => void {
	if (provider !== "openai") return () => {};
	const cerebras = process.env.CEREBRAS_API_KEY?.trim();
	if (!cerebras) return () => {};
	if (process.env.OPENAI_API_KEY?.trim()) return () => {};

	const previous = {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
		OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,
		OPENAI_MEDIUM_MODEL: process.env.OPENAI_MEDIUM_MODEL,
		OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,
		OPENAI_ACTION_PLANNER_MODEL: process.env.OPENAI_ACTION_PLANNER_MODEL,
		OPENAI_PLANNER_MODEL: process.env.OPENAI_PLANNER_MODEL,
	};

	process.env.OPENAI_API_KEY = cerebras;
	process.env.OPENAI_BASE_URL ||= "https://api.cerebras.ai/v1";
	process.env.OPENAI_LARGE_MODEL ||= "gpt-oss-120b";
	process.env.OPENAI_MEDIUM_MODEL ||= process.env.OPENAI_LARGE_MODEL;
	process.env.OPENAI_SMALL_MODEL ||= "gpt-oss-120b";
	process.env.OPENAI_ACTION_PLANNER_MODEL ||= process.env.OPENAI_LARGE_MODEL;
	process.env.OPENAI_PLANNER_MODEL ||= process.env.OPENAI_ACTION_PLANNER_MODEL;

	return () => {
		for (const [k, v] of Object.entries(previous)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
}

function effectiveRequiredEnv(opts: LiveAgentTestOptions): {
	missing: string[];
	hasCerebrasFallback: boolean;
} {
	const provider = opts.provider ?? "openai";
	const required = [...opts.requiredEnv];
	const missing = required.filter((k) => !process.env[k]?.trim());

	// Cerebras fallback: if missing list mentions OPENAI_API_KEY but
	// CEREBRAS_API_KEY is set, that satisfies the requirement.
	const hasCerebrasFallback =
		provider === "openai" &&
		missing.includes("OPENAI_API_KEY") &&
		Boolean(process.env.CEREBRAS_API_KEY?.trim());

	const filtered = hasCerebrasFallback
		? missing.filter((k) => k !== "OPENAI_API_KEY")
		: missing;

	return { missing: filtered, hasCerebrasFallback };
}

/**
 * Ping the Ollama server's `/api/tags` endpoint with a 2-second timeout.
 * Returns true if the server responds 2xx, false otherwise. Used to skip
 * Ollama live tests cleanly when OLLAMA_API_ENDPOINT is set but no server
 * is actually running.
 */
export async function pingOllamaReachable(endpoint: string): Promise<boolean> {
	const base = endpoint.replace(/\/api\/?$/, "").replace(/\/$/, "");
	if (!base) return false;
	try {
		const res = await fetch(`${base}/api/tags`, {
			method: "GET",
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function buildLiveHarness(
	opts: LiveAgentTestOptions,
): Promise<LiveAgentHarness> {
	const provider = opts.provider ?? "openai";
	const restoreEnv = maybeApplyCerebrasAlias(provider);

	const providerPlugin = await resolveProviderPlugin(provider);
	if (!providerPlugin) {
		restoreEnv();
		throw new Error(
			`[live-agent-test] failed to resolve provider plugin for ${provider}`,
		);
	}

	const plugins: Plugin[] = [providerPlugin];
	for (const entry of opts.extraPlugins ?? []) {
		const extra = await loadExtraPlugin(entry);
		if (!extra) {
			throw new Error(
				`[live-agent-test] failed to load extra plugin: ${
					typeof entry === "string" ? entry : entry.path
				}`,
			);
		}
		plugins.push(extra);
	}

	const agentId = randomUUID() as UUID;
	const character: Character = {
		id: agentId,
		name: "LiveTestAgent",
		system: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
		bio: ["Live e2e test agent"],
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

	const adapter = new InMemoryDatabaseAdapter();
	await adapter.init();

	const runtime = new AgentRuntime({
		agentId,
		character,
		adapter,
		plugins,
		checkShouldRespond: false,
		logLevel: "warn",
	});

	applyProviderSettings(runtime, provider);
	await runtime.initialize();

	const worldId = randomUUID() as UUID;
	await runtime.createWorld({ id: worldId, name: "live-world", agentId });
	const roomId = randomUUID() as UUID;
	await runtime.ensureRoomExists({
		id: roomId,
		name: "live-chat",
		source: "live-test",
		type: ChannelType.API,
		worldId,
	});
	await runtime.ensureParticipantInRoom(agentId, roomId);

	const userEntityId = randomUUID() as UUID;
	await runtime.createEntity({
		id: userEntityId,
		names: ["LiveTester"],
		agentId,
	});
	await runtime.ensureParticipantInRoom(userEntityId, roomId);

	const runAgentTurn = async (text: string): Promise<string> => {
		if (!runtime.messageService) {
			throw new Error("[live-agent-test] runtime.messageService is null");
		}
		const message: Memory = {
			id: randomUUID() as UUID,
			entityId: userEntityId,
			roomId,
			content: { text, source: "live-test" },
			createdAt: Date.now(),
		};
		let reply = "";
		await runtime.messageService.handleMessage(
			runtime,
			message,
			async (content: { text?: string }) => {
				if (typeof content?.text === "string") reply += content.text;
				return [];
			},
		);
		return reply;
	};

	const close = async (): Promise<void> => {
		try {
			await runtime.stop();
		} finally {
			restoreEnv();
		}
	};

	return { agentId, runtime, runAgentTurn, close };
}

/**
 * Resolve the auto-defaulted required env for a provider. Callers may pass
 * `requiredEnv: []` to fall back entirely on the provider's defaults.
 */
function defaultedRequiredEnv(opts: LiveAgentTestOptions): string[] {
	const provider = opts.provider ?? "openai";
	if (opts.requiredEnv.length > 0) return opts.requiredEnv;
	return PROVIDER_CONFIG[provider].defaultRequiredEnv;
}

function emitSkip(name: string, reason: string): void {
	process.env.SKIP_REASON ||= reason;
	console.warn(
		`${YELLOW}[live-agent-test] ${name} skipped — ${reason}${RESET}`,
	);
	describe(name, () => {
		it.skip(`[live] suite skipped — ${reason}`, () => {});
	});
}

/**
 * Register a vitest `describe` block that boots a real AgentRuntime against a
 * live LLM provider. When required env is missing, the suite is skipped with
 * a yellow warning.
 *
 * This function is async because some providers (currently `ollama`) need a
 * pre-flight network reachability check before tests are registered. Callers
 * should `await describeLive(...)` at module top level — vitest supports
 * top-level await in test files.
 */
export async function describeLive(
	name: string,
	opts: LiveAgentTestOptions,
	body: (ctx: { harness: () => LiveAgentHarness }) => void,
): Promise<void> {
	const provider = opts.provider ?? "openai";
	const required = defaultedRequiredEnv({ ...opts, requiredEnv: opts.requiredEnv });
	const { missing } = effectiveRequiredEnv({ ...opts, requiredEnv: required });

	if (missing.length > 0) {
		const reason = `missing required env: ${missing.join(", ")} (set ${missing.join(", ")} to enable)`;
		emitSkip(name, reason);
		return;
	}

	// Ollama-specific: env is set, but the server might not be running.
	// Do a 2s reachability ping before registering tests so unreachable
	// servers produce a clean skip instead of long timeouts.
	if (provider === "ollama") {
		const endpoint =
			process.env.OLLAMA_API_ENDPOINT?.trim() ||
			process.env.OLLAMA_API_URL?.trim() ||
			"";
		const reachable = await pingOllamaReachable(endpoint);
		if (!reachable) {
			const reason = `OLLAMA_API_ENDPOINT=${endpoint} unreachable (start ollama or unset OLLAMA_API_ENDPOINT to skip cleanly)`;
			emitSkip(name, reason);
			return;
		}
	}

	describe(name, () => {
		let harness: LiveAgentHarness | null = null;
		beforeAll(async () => {
			harness = await buildLiveHarness(opts);
		}, 120_000);
		afterAll(async () => {
			if (harness) {
				await harness.close();
				harness = null;
			}
		});
		body({
			harness: () => {
				if (!harness) {
					throw new Error("[live-agent-test] harness accessed before beforeAll");
				}
				return harness;
			},
		});
	});
}
