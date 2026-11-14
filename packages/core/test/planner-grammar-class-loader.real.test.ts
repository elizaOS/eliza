/**
 * The strict planner grammar in real llama.cpp grammar parsers. A literal
 * class member must load and read back as itself in each llama.cpp copy the
 * repository pins. test/fixtures/llama-grammar-loader.cpp is compiled against
 * the llama-grammar.cpp of two copies:
 * - the elizaOS/llama.cpp fork at the plugins/plugin-local-inference/native/llama.cpp
 *   submodule pin (the desktop llama-server and the AOSP libllama build from
 *   it), whose parse_char reads `\-` but not `\^`;
 * - the copy bundled in llama-cpp-capacitor 0.1.5, whose parse_char reads
 *   neither.
 * Each case builds the grammar with buildPlannerActionGrammarStrict for a
 * parameter `pattern` whose class ends with one kind of member, loads the
 * whole grammar, and matches the compiled class against a member string and a
 * non-member string. Cases come from quint/GrammarClassEscape.qnt
 * (check-grammar-class-escape.mjs passes the generated ones through
 * ELIZA_GRAMMAR_CLASS_MODEL_CASES). The suite needs a C++17 compiler (`CXX`,
 * default `c++`) and skips a parser whose sources are not installed.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlannerActionGrammarStrict } from "../src/runtime/response-grammar";
import type { Action } from "../src/types/components";

interface ModelCase {
	member: number;
	parser: number;
	token: number;
	loaded: boolean;
}

const repository = path.resolve(import.meta.dirname, "../../..");
const fixture = path.join(
	import.meta.dirname,
	"fixtures/llama-grammar-loader.cpp",
);

// Each class is `[a<member>]`; the member comes last. A class that holds `"`,
// `\` or a control character keeps `jsonstring` instead (the value must stay
// valid JSON), so those members never reach a compiled class.
const MEMBERS = [
	{
		label: "a plain character",
		char: "b",
		pattern: "^[ab]+$",
		accept: "ab",
		reject: "c",
	},
	{
		label: "a literal hyphen",
		char: "-",
		pattern: "^[a-]+$",
		accept: "a-",
		reject: "b",
	},
	{
		label: "a literal caret",
		char: "^",
		pattern: "^[a^]+$",
		accept: "a^",
		reject: "b",
	},
	{
		label: "a closing bracket",
		char: "]",
		pattern: "^[a\\]]+$",
		accept: "a]",
		reject: "b",
	},
	{
		label: "a range",
		char: "b-c",
		pattern: "^[ab-c]+$",
		accept: "abc",
		reject: "-",
	},
] as const;

/** The GBNF text for a member, by the model's token kind. */
function written(member: number, token: number): string {
	const { char } = MEMBERS[member];
	switch (token) {
		case 1:
			return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
		case 2:
			return `\\${char}`;
		default:
			return char;
	}
}

function capacitorSources(): string | null {
	try {
		const require = createRequire(
			path.join(repository, "plugins/plugin-native-inference/package.json"),
		);
		return path.join(
			path.dirname(require.resolve("llama-cpp-capacitor/package.json")),
			"cpp",
		);
	} catch {
		return null;
	}
}

const fork = path.join(
	repository,
	"plugins/plugin-local-inference/native/llama.cpp",
);
const capacitor = capacitorSources();
const PARSERS = [
	{
		label: "the elizaOS/llama.cpp submodule pin",
		source: path.join(fork, "src/llama-grammar.cpp"),
		includes: ["src", "include", "ggml/include"].map((dir) =>
			path.join(fork, dir),
		),
	},
	{
		label: "llama-cpp-capacitor",
		source: capacitor ? path.join(capacitor, "llama-grammar.cpp") : null,
		includes: capacitor ? [capacitor] : [],
	},
] as const;

// The fixed writer's token for each member: raw, hex for `-` and `^`, a
// backslash before `]`, and a raw range.
const WRITTEN_TOKENS = [0, 1, 1, 2, 3];
const modelCases: ModelCase[] = process.env.ELIZA_GRAMMAR_CLASS_MODEL_CASES
	? JSON.parse(
			readFileSync(process.env.ELIZA_GRAMMAR_CLASS_MODEL_CASES, "utf8"),
		)
	: PARSERS.flatMap((_, parser) =>
			WRITTEN_TOKENS.map((token, member) => ({
				member,
				parser,
				token,
				loaded: true,
			})),
		);

const compiler = process.env.CXX?.trim() || "c++";
const hasCompiler =
	process.platform !== "win32" &&
	spawnSync(compiler, ["--version"], { stdio: "ignore" }).status === 0;
const available = PARSERS.map(
	(parser) =>
		hasCompiler && parser.source !== null && existsSync(parser.source),
);

let directory = "";
let grammars = 0;
const loaders: string[] = [];

function plannerGrammar(pattern: string): string {
	const action: Pick<Action, "name" | "parameters"> = {
		name: "PROPOSE_DEVICE_ACTION",
		parameters: [
			{
				name: "operationKey",
				description: "Fresh key for each new operation",
				required: true,
				schema: { type: "string", pattern },
			},
		],
	};
	return buildPlannerActionGrammarStrict([action])?.grammar ?? "";
}

function load(parser: number, grammar: string, inputs: string[]): string[] {
	const file = path.join(directory, `grammar-${grammars++}.gbnf`);
	writeFileSync(file, grammar);
	const run = spawnSync(loaders[parser], [file, ...inputs], {
		encoding: "utf8",
	});
	expect(run.status, run.stderr).toBe(0);
	return run.stdout.trim().split("\n");
}

beforeAll(() => {
	directory = mkdtempSync(path.join(tmpdir(), "llama-grammar-loader-"));
	PARSERS.forEach((parser, index) => {
		if (!available[index] || parser.source === null) return;
		const output = path.join(directory, `loader-${index}`);
		// llama-grammar.cpp also holds sampler glue that refers to the
		// vocabulary. Parsing and matching do not call it.
		const built = spawnSync(
			compiler,
			[
				"-std=c++17",
				"-O1",
				...parser.includes.map((include) => `-I${include}`),
				fixture,
				parser.source,
				...(process.platform === "darwin"
					? ["-Wl,-undefined,dynamic_lookup"]
					: [
							// Default PIE executables give unused, unresolved sampler
							// symbols invalid PLT relocations before main runs on Linux.
							"-no-pie",
							"-Wl,--unresolved-symbols=ignore-all",
						]),
				"-o",
				output,
			],
			{ encoding: "utf8" },
		);
		if (built.status !== 0) {
			throw new Error(`Building the grammar loader failed:\n${built.stderr}`);
		}
		loaders[index] = output;
	});
});

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("strict planner grammar classes in pinned llama.cpp grammar parsers", () => {
	for (const { member, parser, token, loaded } of modelCases) {
		it.skipIf(!available[parser])(
			`loads and matches the generated case for ${MEMBERS[member].label} in ${PARSERS[parser].label}`,
			() => {
				const grammar = plannerGrammar(MEMBERS[member].pattern);
				expect(load(parser, grammar, [])).toEqual([
					loaded ? "LOADED" : "LOAD FAILED",
				]);
				const compiledClass = `[a${written(member, token)}]+`;
				expect(grammar).toContain(compiledClass);
				if (!loaded) return;
				expect(
					load(parser, `root ::= ${compiledClass}\n`, [
						MEMBERS[member].accept,
						MEMBERS[member].reject,
					]),
				).toEqual(["LOADED", "ACCEPT", "REJECT"]);
			},
		);
	}
});
