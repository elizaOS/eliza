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
import { afterAll, beforeAll, describe, it } from "vitest";
import { v4 as uuidv4 } from "uuid";

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
	| "openrouter";

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
	switch (provider) {
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
		case "google": {
			const mod = await importWorkspacePlugin(
				"../../../../plugins/plugin-google-genai/index.ts",
				"@elizaos/plugin-google-genai",
			);
			if (!mod) return null;
			return (mod.default as Plugin | undefined) ?? null;
		}
		case "groq": {
			const mod = await importWorkspacePlugin(
				"../../../../plugins/plugin-groq/index.ts",
				"@elizaos/plugin-groq",
			);
			if (!mod) return null;
			return ((mod.groqPlugin ?? mod.default) as Plugin | undefined) ?? null;
		}
		case "openrouter": {
			const mod = await importWorkspacePlugin(
				"../../../../plugins/plugin-openrouter/index.ts",
				"@elizaos/plugin-openrouter",
			);
			if (!mod) return null;
			return (
				((mod.openrouterPlugin ?? mod.default) as Plugin | undefined) ?? null
			);
		}
	}
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
			if (process.env.OPENAI_SMALL_MODEL) {
				runtime.setSetting("OPENAI_SMALL_MODEL", process.env.OPENAI_SMALL_MODEL);
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
		OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,
	};

	process.env.OPENAI_API_KEY = cerebras;
	process.env.OPENAI_BASE_URL ||= "https://api.cerebras.ai/v1";
	process.env.OPENAI_LARGE_MODEL ||= "gpt-oss-120b";
	process.env.OPENAI_SMALL_MODEL ||= "gpt-oss-120b";

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

	const agentId = uuidv4() as UUID;
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

	const worldId = uuidv4() as UUID;
	await runtime.createWorld({ id: worldId, name: "live-world", agentId });
	const roomId = uuidv4() as UUID;
	await runtime.ensureRoomExists({
		id: roomId,
		name: "live-chat",
		source: "live-test",
		type: ChannelType.API,
		worldId,
	});
	await runtime.ensureParticipantInRoom(agentId, roomId);

	const userEntityId = uuidv4() as UUID;
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
			id: uuidv4() as UUID,
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

export function describeLive(
	name: string,
	opts: LiveAgentTestOptions,
	body: (ctx: { harness: () => LiveAgentHarness }) => void,
): void {
	const { missing } = effectiveRequiredEnv(opts);
	if (missing.length > 0) {
		const reason = `missing required env: ${missing.join(", ")}`;
		// Annotate so fail-on-silent-skip allows it.
		process.env.SKIP_REASON ||= reason;
		console.warn(
			`${YELLOW}[live-agent-test] ${name} skipped — ${reason} (set ${missing.join(
				", ",
			)} to enable)${RESET}`,
		);
		describe(name, () => {
			it.skip(
				`[live] suite skipped — set ${missing.join(", ")} to enable`,
				() => {},
			);
		});
		return;
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
