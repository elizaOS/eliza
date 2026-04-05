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
 *
 * Usage:
 *   bun run harness
 *   bun run harness -- --character ./path/to/character.json
 *   bun run harness -- --log-level info
 *
 * Inference: set OPENAI_API_KEY for OpenAI, or run Ollama locally. Override with HARNESS_PROVIDER=openai|ollama.
 *
 * Database: PGLite via @elizaos/plugin-sql (default). Data dir: PGLITE_DATA_DIR, HARNESS_PGLITE_DIR, or `.eliza/harness-pglite`.
 * For in-memory DB instead, use `InMemoryDatabaseAdapter` from `@elizaos/core`, drop plugin-sql from the character, and pass that adapter to `createRuntimes`.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import {
	ChannelType,
	createRuntimes,
	getBasicCapabilitiesSettings,
	loadCharacters,
	MemoryType,
	stringToUuid,
	type Character,
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type UUID,
} from "@elizaos/core";
import { defaultCharacter } from "./defaultCharacter";

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
`);
}

function preferOpenAiPlugin(): boolean {
	return (
		process.env.HARNESS_PROVIDER === "openai" ||
		(!!process.env.OPENAI_API_KEY &&
			process.env.HARNESS_PROVIDER !== "ollama")
	);
}

/** Ensure string plugin names for SQL + inference are present; preserves existing non-string Plugin objects. */
function mergeHarnessSqlPlugins(character: Character): Character {
	const existingPlugins = character.plugins ?? [];
	const stringPlugins = existingPlugins.filter(
		(p: unknown): p is string => typeof p === "string",
	);
	const nonStringPlugins = existingPlugins.filter(
		(p: unknown) => typeof p !== "string",
	);
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
	return { ...character, plugins: [...nonStringPlugins, ...list] };
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
			PGLITE_DATA_DIR:
				process.env.PGLITE_DATA_DIR ??
				process.env.HARNESS_PGLITE_DIR ??
				pgliteDirDefault,
			/** Harness is direct chat: always respond (overrides character JSON if set). */
			CHECK_SHOULD_RESPOND: false,
		},
	}));

	characters = characters.map(mergeHarnessSqlPlugins);

	const logLevel = resolveLogLevel(cliLogLevel);

	// Create one adapter per character so each can use its own DB settings
	const adapters: Map<string, ReturnType<typeof createDatabaseAdapter>> = new Map();
	for (const char of characters) {
		const caps = getBasicCapabilitiesSettings(char);
		const charId = (char.id ?? stringToUuid(char.name ?? "eliza")) as UUID;
		const adapter = createDatabaseAdapter(
			{
				dataDir: caps.PGLITE_DATA_DIR,
				postgresUrl: caps.POSTGRES_URL,
			},
			charId,
		);
		adapters.set(charId, adapter);
	}

	// Create runtimes individually with per-character adapters
	const runtimes: IAgentRuntime[] = [];
	for (const char of characters) {
		const charId = (char.id ?? stringToUuid(char.name ?? "eliza")) as UUID;
		const adapter = adapters.get(charId)!;
		const [runtime] = await createRuntimes([char], {
			adapter,
			logLevel,
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
		try {
			await runtime.stop();
		} catch {
			/* ignore */
		}
		process.exit(code);
	};

	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));

	output.write(
		`\n@elizaos/agent harness | ${character.name ?? "agent"} | type "exit" or Ctrl+D to quit\n\n`,
	);

	const callback: HandlerCallback = async (response: Content) => {
		const text = response?.text;
		if (text) {
			output.write(`${text}\n`);
		}
		return [];
	};

	try {
		while (true) {
			let line: string;
			try {
				line = await rl.question("> ");
			} catch {
				break;
			}

			const trimmed = line.trim();
			if (trimmed === "") {
				continue;
			}
			if (trimmed.toLowerCase() === "exit") {
				break;
			}

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
				metadata: { type: MemoryType.MESSAGE },
			};

			if (!runtime.messageService) {
				output.write("messageService not ready\n");
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
			rl.close();
			await runtime.stop();
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
