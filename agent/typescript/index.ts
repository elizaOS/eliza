/**
 * Dev harness: stdin/stdout REPL around @elizaos/core (v1-develop `agent/` style, 2.x API).
 *
 * Uses `loadCharacters` + `createRuntimes` from `@elizaos/core` (runtime-composition), same as other hosts.
 * `@elizaos/plugin-sql` registers the DB in `init` only (no `adapter` factory), so we build the adapter with
 * `createDatabaseAdapter` and pass `createRuntimes(characters, { adapter })` — equivalent to what the plugin does at runtime.
 *
 * Prerequisite: built core (`bun run build:core` from repo root) so workspace `@elizaos/core` resolves to `dist/`.
 *
 * Usage:
 *   bun run harness
 *   bun run harness -- --character ./path/to/character.json
 *
 * Inference: set OPENAI_API_KEY for OpenAI, or run Ollama locally. Override with HARNESS_PROVIDER=openai|ollama.
 *
 * Database: PGLite via @elizaos/plugin-sql (default). Data dir: PGLITE_DATA_DIR, HARNESS_PGLITE_DIR, or `.eliza/harness-pglite`.
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
	type CharacterInput,
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type UUID,
} from "@elizaos/core";
import { defaultCharacter } from "./defaultCharacter";

function parseHarnessArgs(): { characterPath?: string } {
	const args = process.argv.slice(2);
	let characterPath: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--character" && args[i + 1]) {
			characterPath = args[++i];
		}
	}
	return { characterPath };
}

function preferOpenAiPlugin(): boolean {
	return (
		process.env.HARNESS_PROVIDER === "openai" ||
		(!!process.env.OPENAI_API_KEY &&
			process.env.HARNESS_PROVIDER !== "ollama")
	);
}

/** Ensure string plugin names for SQL + inference (createRuntimes only collects string entries from character.plugins). */
function mergeHarnessSqlPlugins(character: Character): Character {
	const existing = (character.plugins ?? []).filter(
		(p: unknown): p is string => typeof p === "string",
	);
	const list = [...existing];
	if (!list.some((s) => s.includes("plugin-sql"))) {
		list.unshift("@elizaos/plugin-sql");
	}
	if (
		!list.some((s) =>
			/plugin-openai|plugin-ollama|plugin-anthropic|plugin-groq/.test(s),
		)
	) {
		list.push(
			preferOpenAiPlugin()
				? "@elizaos/plugin-openai"
				: "@elizaos/plugin-ollama",
		);
	}
	return { ...character, plugins: list };
}

/** For in-memory DB: drop plugin-sql, keep inference defaults. */
function mergeHarnessPluginsNoSql(character: Character): Character {
	const existing = (character.plugins ?? []).filter(
		(p: unknown): p is string =>
			typeof p === "string" && !p.includes("plugin-sql"),
	);
	const list = [...existing];
	if (
		!list.some((s) =>
			/plugin-openai|plugin-ollama|plugin-anthropic|plugin-groq/.test(s),
		)
	) {
		list.push(
			preferOpenAiPlugin()
				? "@elizaos/plugin-openai"
				: "@elizaos/plugin-ollama",
		);
	}
	return { ...character, plugins: list };
}

async function main(): Promise<void> {
	const { characterPath } = parseHarnessArgs();

	const sources: Array<CharacterInput | string> = characterPath
		? [characterPath]
		: [defaultCharacter as CharacterInput];

	let characters = await loadCharacters(sources);

	const pgliteDirDefault = path.join(process.cwd(), ".eliza", "harness-pglite");

	// --- PGLite only: merge data dir into settings (comment this whole block for in-memory DB) ---
	characters = characters.map((c: Character) => ({
		...c,
		settings: {
			...c.settings,
			PGLITE_DATA_DIR:
				process.env.PGLITE_DATA_DIR ??
				process.env.HARNESS_PGLITE_DIR ??
				pgliteDirDefault,
		},
	}));

	characters = characters.map(mergeHarnessSqlPlugins);

	const logLevel =
		(process.env.LOG_LEVEL as
			| "trace"
			| "debug"
			| "info"
			| "warn"
			| "error"
			| "fatal") ?? "debug";

	const primary = characters[0]!;
	const caps = getBasicCapabilitiesSettings(primary);
	const sqlAdapter = createDatabaseAdapter(
		{
			dataDir: caps.PGLITE_DATA_DIR,
			postgresUrl: caps.POSTGRES_URL,
		},
		(primary.id ?? stringToUuid(primary.name ?? "eliza")) as UUID,
	);

	const runtimes = await createRuntimes(characters, {
		adapter: sqlAdapter,
		logLevel,
		checkShouldRespond: false,
	});

	const runtime = runtimes[0] as IAgentRuntime | undefined;
	if (!runtime) {
		throw new Error("createRuntimes returned no runtimes");
	}

	// --- Database: in-memory (comment out PGLite sections above; uncomment below + add import) ---
	// import { InMemoryDatabaseAdapter } from "@elizaos/core";
	// let characters = await loadCharacters(sources);
	// characters = characters.map(mergeHarnessPluginsNoSql);
	// const runtimes = await createRuntimes(characters, {
	// 	adapter: new InMemoryDatabaseAdapter(),
	// 	logLevel,
	// 	checkShouldRespond: false,
	// });
	// const runtime = runtimes[0] as IAgentRuntime | undefined;

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
			const line = await rl.question("> ");
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.toLowerCase() === "exit") {
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
				break;
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
		rl.close();
		await runtime.stop();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
