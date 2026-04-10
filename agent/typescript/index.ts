/**
 * Dev harness: stdin/stdout REPL around @elizaos/core (v1-develop `agent/` style, 2.x API).
 *
 * Uses `loadCharacters` + `createRuntimes` from `@elizaos/core` (runtime-composition), same as other hosts.
 * `@elizaos/plugin-sql` registers the DB in `init` only (no `adapter` factory), so we build the adapter with
 * `createDatabaseAdapter` and pass `createRuntimes(characters, { adapter })` — equivalent to what the plugin does at runtime.
 *
 * Multi-character support: Each character gets its own database adapter using its own PGLITE_DATA_DIR / POSTGRES_URL
 * settings. Characters without explicit settings fall back to the harness default.
 *
 * Prerequisite: built core (`bun run build:core` from repo root) so workspace `@elizaos/core` resolves to `dist/`.
 * `createRuntimes` uses `provision: true` so plugin-sql migrations run before the first DB read (fresh PGLite dirs get schema).
 *
 * Usage:
 *   bun run harness
 *   bun run harness -- --character ./path/to/character.json
 *   bun run harness -- --log-level info
 *
 * Inference: set OPENAI_API_KEY for OpenAI, or run Ollama locally. Override with HARNESS_PROVIDER=openai|ollama.
 * Ollama: set `OLLAMA_*` in repo `.env` (or `agent/.env`). `getSetting()` falls back to `process.env` for those keys so the endpoint is visible even when plugins init before DB merge; the harness also copies them into `character.settings` when present.
 *
 * Env files: with `--cwd agent`, Bun loads `agent/.env` only. This harness also loads `../.env` and `../.env.local` (repo root) so keys like `PROMPT_OPTIMIZATION_ENABLED` in the root file apply. Existing `process.env` wins (no override).
 *
 * Database: PGLite via @elizaos/plugin-sql (default). Data dir: PGLITE_DATA_DIR, HARNESS_PGLITE_DIR, or `.eliza/harness-pglite`.
 * For in-memory DB instead, use `InMemoryDatabaseAdapter` from `@elizaos/core`, drop plugin-sql from the character, and pass that adapter to `createRuntimes`.
 */

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import {
	ChannelType,
	createRuntimes,
	getBasicCapabilitiesSettings,
	loadCharacters,
	logger,
	MemoryType,
	neuroPlugin,
	stringToUuid,
	type Character,
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type Plugin,
	type UUID,
} from "@elizaos/core";
import { defaultCharacter } from "./defaultCharacter";

/**
 * Parse a minimal dotenv file (KEY=value, optional quotes, optional `export `).
 * Does not support multiline values.
 */
function parseDotEnvFile(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (let line of content.split("\n")) {
		line = line.replace(/^\uFEFF/, "").trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("export ")) line = line.slice(7).trim();
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!/^[\w.-]+$/.test(key)) continue;
		let val = line.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

/**
 * Merge repo-root + cwd dotenv into `process.env` for keys that are still unset.
 * Order: `../.env` → `../.env.local` → `./.env` → `./.env.local` (later files win in the merge, shell/Bun still wins over files).
 */
function loadHarnessDotEnvFiles(): void {
	const cwd = process.cwd();
	const files = [
		path.join(cwd, "..", ".env"),
		path.join(cwd, "..", ".env.local"),
		path.join(cwd, ".env"),
		path.join(cwd, ".env.local"),
	];
	const merged: Record<string, string> = {};
	for (const file of files) {
		if (!existsSync(file)) continue;
		try {
			const raw = readFileSync(file, "utf8");
			Object.assign(merged, parseDotEnvFile(raw));
		} catch {
			/* unreadable file */
		}
	}
	for (const [k, v] of Object.entries(merged)) {
		if (process.env[k] === undefined) {
			process.env[k] = v;
		}
	}
}

/** Ollama plugin reads these via `runtime.getSetting`; env must be mirrored here (see file header). */
const OLLAMA_ENV_SETTING_KEYS = [
	"OLLAMA_API_ENDPOINT",
	"OLLAMA_API_URL",
	"OLLAMA_SMALL_MODEL",
	"OLLAMA_MEDIUM_MODEL",
	"OLLAMA_LARGE_MODEL",
	"OLLAMA_EMBEDDING_MODEL",
	"SMALL_MODEL",
	"LARGE_MODEL",
] as const;

function ollamaSettingsFromEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of OLLAMA_ENV_SETTING_KEYS) {
		const v = process.env[key];
		if (v !== undefined && v !== "") {
			out[key] = v;
		}
	}
	return out;
}

/** Mirror .env into settings so harness + runtime agree (same pattern as Ollama keys). */
function promptOptimizationSettingsFromEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	const po = process.env.PROMPT_OPTIMIZATION_ENABLED;
	if (po !== undefined && po !== "") {
		out.PROMPT_OPTIMIZATION_ENABLED = po;
	}
	const dir = process.env.OPTIMIZATION_DIR;
	if (dir !== undefined && dir !== "") {
		out.OPTIMIZATION_DIR = dir;
	}
	return out;
}

const LOG_LEVELS = [
	"trace",
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
] as const;

type HarnessLogLevel = (typeof LOG_LEVELS)[number];

function isHarnessLogLevel(s: string): s is HarnessLogLevel {
	return (LOG_LEVELS as readonly string[]).includes(s);
}

function parseHarnessArgs(): {
	characterPath?: string;
	logLevel?: HarnessLogLevel;
	help?: boolean;
	unknownFlags: string[];
} {
	const args = process.argv.slice(2);
	let characterPath: string | undefined;
	let logLevel: HarnessLogLevel | undefined;
	let help = false;
	const unknownFlags: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--help" || a === "-h") {
			help = true;
			continue;
		}
		if (a === "--character" && args[i + 1]) {
			characterPath = args[++i];
			continue;
		}
		if (a === "--log-level" && args[i + 1]) {
			const v = args[++i];
			if (isHarnessLogLevel(v)) {
				logLevel = v;
			} else {
				unknownFlags.push(`--log-level ${v} (expected ${LOG_LEVELS.join("|")})`);
			}
			continue;
		}
		if (a?.startsWith("-")) {
			unknownFlags.push(a);
		}
	}

	return { characterPath, logLevel, help, unknownFlags };
}

function printUsage(): void {
	output.write(`@elizaos/agent harness

Usage:
  bun run harness [options]

Options:
  --character <path>     Load character JSON (relative paths use process.cwd())
  --log-level <level>    ${LOG_LEVELS.join(" | ")} (overrides LOG_LEVEL when set)
  -h, --help             Show this message

Environment:
  LOG_LEVEL, OPENAI_API_KEY, HARNESS_PROVIDER=openai|ollama, PGLITE_DATA_DIR, HARNESS_PGLITE_DIR
  PROMPT_OPTIMIZATION_ENABLED=true — enables DPE traces and injects plugin-neuro (text quality signals + RUN_ENDED finalizer; emoji reactions optional)
`);
}

function preferOpenAiPlugin(): boolean {
	return (
		process.env.HARNESS_PROVIDER === "openai" ||
		(!!process.env.OPENAI_API_KEY &&
			process.env.HARNESS_PROVIDER !== "ollama")
	);
}

function isTruthySetting(v: unknown): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		const t = v.trim().toLowerCase();
		return t === "true" || v.trim() === "1";
	}
	return false;
}

/**
 * When prompt optimization is on, enriched traces and A/B analysis expect plugin-neuro
 * (evaluator signals + RUN_ENDED finalizer). Reactions are optional; text-only harnesses
 * still get length, latency, and continuation signals.
 */
function isPromptOptimizationEnabledForHarness(character: Character): boolean {
	const fromChar = (character.settings as Record<string, unknown> | undefined)
		?.PROMPT_OPTIMIZATION_ENABLED;
	if (fromChar !== undefined && fromChar !== null && fromChar !== "") {
		return isTruthySetting(fromChar);
	}
	return isTruthySetting(process.env.PROMPT_OPTIMIZATION_ENABLED);
}

function hasNeuroPlugin(plugins: Character["plugins"]): boolean {
	if (!plugins) return false;
	for (const p of plugins) {
		if (typeof p === "string") {
			const s = p.toLowerCase();
			if (
				s === "plugin-neuro" ||
				s.endsWith("plugin-neuro") ||
				s.includes("@elizaos/plugin-neuro")
			) {
				return true;
			}
		} else if (
			p &&
			typeof p === "object" &&
			"name" in p &&
			(p as Plugin).name === "plugin-neuro"
		) {
			return true;
		}
	}
	return false;
}

/** Ensure string plugin names for SQL + inference are present; preserves existing non-string Plugin objects. */
function mergeHarnessSqlPlugins(character: Character): Character {
	const existingPlugins = character.plugins ?? [];
	const stringPlugins = existingPlugins.filter(
		(p: unknown): p is string => typeof p === "string",
	);
	const nonStringPlugins = existingPlugins.filter(
		(p) => typeof p !== "string",
	) as Plugin[];
	const list = [...stringPlugins];
	if (!list.some((s) => s.includes("plugin-sql"))) {
		list.unshift("@elizaos/plugin-sql");
	}
	if (
		!list.some((s) =>
			/plugin-openai|plugin-ollama|plugin-local-ai|plugin-anthropic|plugin-groq/.test(
				s,
			),
		)
	) {
		list.push(
			preferOpenAiPlugin()
				? "@elizaos/plugin-openai"
				: "@elizaos/plugin-ollama",
		);
	}

	let mergedNonString = nonStringPlugins;
	if (
		isPromptOptimizationEnabledForHarness(character) &&
		!hasNeuroPlugin(existingPlugins)
	) {
		mergedNonString = [...nonStringPlugins, neuroPlugin];
	}

	const combinedPlugins: (string | Plugin)[] = [...mergedNonString, ...list];
	return {
		...character,
		plugins: combinedPlugins as Character["plugins"],
	};
// Note: Ensures SQL + inference plugins present; preserves non-string plugins (prepended).
}

function resolveLogLevel(cli?: HarnessLogLevel): HarnessLogLevel {
	if (cli) {
		return cli;
	}
	const env = process.env.LOG_LEVEL?.trim();
	if (env && isHarnessLogLevel(env)) {
		return env;
	}
	return "debug";
}

async function main(): Promise<void> {
	loadHarnessDotEnvFiles();

	const { characterPath, logLevel: cliLogLevel, help, unknownFlags } =
		parseHarnessArgs();

	if (help) {
		printUsage();
		return;
	}

	if (unknownFlags.length > 0) {
		for (const f of unknownFlags) {
			console.error(`Unknown or invalid option: ${f}`);
		}
		printUsage();
		process.exitCode = 1;
		return;
	}

	const sources: Array<Character | string> = characterPath
		? [characterPath]
		: [defaultCharacter];

	let characters = await loadCharacters(sources);

	const pgliteDirDefault = path.join(process.cwd(), ".eliza", "harness-pglite");

	characters = characters.map((c: Character) => ({
		...c,
		settings: {
			...c.settings,
			...ollamaSettingsFromEnv(),
			...promptOptimizationSettingsFromEnv(),
			PGLITE_DATA_DIR:
				(c.settings as Record<string, unknown> | undefined)?.PGLITE_DATA_DIR ??
				process.env.PGLITE_DATA_DIR ??
				process.env.HARNESS_PGLITE_DIR ??
				pgliteDirDefault,
			/** Harness is direct chat: always respond (overrides character JSON if set). */
			CHECK_SHOULD_RESPOND: false,
		},
	}));

	characters = characters.map(mergeHarnessSqlPlugins);

	const firstChar = characters[0];
	if (firstChar) {
		const optOn = isPromptOptimizationEnabledForHarness(firstChar);
		const neuroPresent = hasNeuroPlugin(firstChar.plugins ?? []);
		if (optOn && neuroPresent) {
			logger.info(
				{ src: "harness", pluginNeuro: true },
				"Prompt optimization: plugin-neuro merged; DPE traces + RUN_ENDED finalizer active",
			);
		} else if (optOn && !neuroPresent) {
			logger.warn(
				{ src: "harness", pluginNeuro: false },
				"PROMPT_OPTIMIZATION_ENABLED is true but plugin-neuro was not added (check plugins list for a false-positive /neuro/ string match)",
			);
		}
	}

	const logLevel = resolveLogLevel(cliLogLevel);

	// Create one adapter per character so each can use its own DB settings
	// Note: Using array index as key to avoid collision when multiple characters share the same name.
	const adapters: Map<number, ReturnType<typeof createDatabaseAdapter>> = new Map();
	for (let i = 0; i < characters.length; i++) {
		const char = characters[i]!;
		const caps = getBasicCapabilitiesSettings(char);
		// Use explicit id if present; otherwise generate unique id by including index to avoid collision for same-named characters
		const charId = (char.id ?? stringToUuid(`${char.name ?? "eliza"}-${i}`)) as UUID;
		const adapter = createDatabaseAdapter(
			{
				dataDir: caps.PGLITE_DATA_DIR,
				postgresUrl: caps.POSTGRES_URL,
			},
			charId,
		);
		adapters.set(i, adapter);
	// Note: charId includes index to ensure unique identifiers for characters with duplicate names.
	}

	// Create runtimes individually with per-character adapters
	const runtimes: IAgentRuntime[] = [];
	for (let i = 0; i < characters.length; i++) {
		const char = characters[i]!;
		const adapter = adapters.get(i)!;
		const [runtime] = await createRuntimes([char], {
			adapter,
			logLevel,
			provision: true,
		});
		if (runtime) {
			runtimes.push(runtime);
		}
	}

	const runtime = runtimes[0] as IAgentRuntime | undefined;
	if (!runtime) {
		throw new Error("createRuntimes returned no runtimes");
	}

	const character = characters[0]!;

	const worldId = stringToUuid("eliza-harness-world");
	const roomId = stringToUuid("eliza-harness-room");
	const userEntityId = stringToUuid("eliza-harness-user");

	await runtime.ensureConnection({
		entityId: userEntityId,
		roomId,
		worldId,
		worldName: "harness",
		userName: "You",
		source: "harness",
		type: ChannelType.DM,
	});

	const rl = createInterface({ input, output, terminal: true });

	let shuttingDown = false;
	const shutdown = async (code: number) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		try {
			rl.close();
		} catch {
			/* ignore */
		}
		// Stop all runtimes to avoid leaking resources
		for (const rt of runtimes) {
			try {
				await rt.stop();
			} catch {
				/* ignore */
			}
		}
		process.exit(code);
	// Note: Shutdown is focused on the first runtime to simplify error handling in this context.
	};

	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));

	output.write(
		`\n@elizaos/agent harness | ${character.name ?? "agent"} | type "exit" or Ctrl+D to quit\n\n`,
	);

	const callback: HandlerCallback = async (response: Content) => {
		const text = response?.text;
		if (text) {
			console.log('==============================================');
			output.write(`${text}\n`);
			console.log('==============================================');
		}
		return [];
	};

	try {
		while (true) {
			let line: string;
			try {
				line = await rl.question("> ");
			} catch {
				// Note: breaks loop on input error to prevent infinite prompts on failure
				break;
			}

			const trimmed = line.trim();
			if (trimmed === "") {
				continue;
			}
			if (trimmed.toLowerCase() === "exit") {
				break;
			}
// Note: empty lines and "exit" command are handled to maintain clean input processing.

			const message: Memory = {
				id: crypto.randomUUID() as UUID,
				content: {
					text: trimmed,
					source: "harness",
					channelType: ChannelType.DM,
				},
				entityId: userEntityId,
				roomId,
				agentId: runtime.agentId,
				createdAt: Date.now(),
				// Note: skips current message handling if messageService isn't ready, allowing REPL to continue.
				metadata: { type: MemoryType.MESSAGE },
			};

			if (!runtime.messageService) {
				output.write("messageService not ready — skipping message\n");
				continue;
			}

			try {
				await runtime.messageService.handleMessage(
					runtime,
					message,
					callback,
				);
			} catch (err) {
				console.error(err);
			}
		}
	} finally {
		if (!shuttingDown) {
			shuttingDown = true;
			rl.close();
			// Stop all runtimes to avoid leaking resources
			for (const rt of runtimes) {
				try {
					await rt.stop();
				} catch {
					/* ignore */
				}
			}
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
