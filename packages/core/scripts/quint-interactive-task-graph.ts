/** Rebuilds the reducer graph from the same Quint relation that model checking uses. */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;
interface JsonRecord {
	[key: string]: JsonValue;
}
interface StateGraph {
	variables: string[];
	states: JsonRecord[];
	initial: number[];
	next: number[][];
}

function record(value: JsonValue, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Expected a record for ${label}`);
	}
	return value;
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
	if (!Array.isArray(value)) throw new Error(`Expected a list for ${label}`);
	return value;
}

/** Decode the containers used by the standard Informal Trace Format. */
function decode(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(decode);
	if (!value || typeof value !== "object") return value;
	if ("#set" in value) return array(value["#set"], "set").map(decode);
	if ("#tup" in value) return array(value["#tup"], "tuple").map(decode);
	if ("#map" in value) {
		return Object.fromEntries(
			array(value["#map"], "map").map((entry) => {
				const pair = array(entry, "map entry");
				if (pair.length !== 2 || typeof pair[0] !== "string") {
					throw new Error("The task model must use string-keyed maps");
				}
				return [pair[0], decode(pair[1] as JsonValue)];
			}),
		);
	}
	return Object.fromEntries(
		Object.keys(value)
			.filter((key) => key !== "#meta")
			.sort()
			.map((key) => [key, decode(value[key] as JsonValue)]),
	);
}

export function stateGraphFromQuintTrace(trace: JsonRecord): StateGraph {
	const states = array(trace.states, "trace states");
	const final = record(decode(states.at(-1) as JsonValue), "final trace state");
	if (array(final.frontier, "frontier").length !== 0) {
		throw new Error("Quint graph exploration did not reach a fixed point");
	}
	const ordered = array(final.seen, "seen states")
		.map((state) => JSON.stringify(record(state, "graph state")))
		.sort();
	if (ordered.length === 0)
		throw new Error("Quint graph exploration returned no states");
	const index = new Map(ordered.map((state, i) => [state, i]));
	const indexOf = (state: JsonValue): number => {
		const i = index.get(JSON.stringify(record(state, "edge state")));
		if (i === undefined)
			throw new Error("Quint graph edge names an undiscovered state");
		return i;
	};
	const next = ordered.map(() => new Set<number>());
	for (const edge of array(final.edges, "graph edges")) {
		const pair = array(edge, "graph edge");
		if (pair.length !== 2)
			throw new Error("Quint graph edge must have two states");
		const from = indexOf(pair[0] as JsonValue);
		const to = indexOf(pair[1] as JsonValue);
		if (from !== to) next[from]?.add(to);
	}
	const initial = indexOf(final.s as JsonValue);
	const decoded = ordered.map((state) => JSON.parse(state) as JsonRecord);
	return {
		variables: Object.keys(decoded[0] as JsonRecord),
		states: decoded,
		initial: [initial],
		next: next.map((edges) => [...edges].sort((a, b) => a - b)),
	};
}

function main() {
	const args = process.argv.slice(2);
	const write = args.includes("--write");
	const model =
		args.find((arg) => arg !== "--write") ??
		fileURLToPath(new URL("../quint/InteractiveTask.qnt", import.meta.url));
	const fixture = fileURLToPath(
		new URL("../quint/InteractiveTask.reducer.graph.json", import.meta.url),
	);
	const require = createRequire(import.meta.url);
	const packageFile = require.resolve("@informalsystems/quint/package.json");
	const installed = JSON.parse(readFileSync(packageFile, "utf8")) as {
		version: string;
		bin: { quint: string };
	};
	if (installed.version !== "0.33.1")
		throw new Error("The task graph requires Quint 0.33.1");
	const cli = path.resolve(path.dirname(packageFile), installed.bin.quint);
	mkdirSync(testOutputPath("quint"), { recursive: true });
	const directory = mkdtempSync(testOutputPath("quint", "interactive-task-"));
	try {
		const output = path.join(directory, "graph.itf.json");
		const result = spawnSync(
			process.execPath,
			[
				cli,
				"run",
				model,
				"--main",
				"InteractiveTaskGraph",
				"--init",
				"graphInit",
				"--step",
				"graphStep",
				"--max-steps",
				"25",
				"--max-samples",
				"1",
				"--seed",
				"1",
				"--backend",
				"typescript",
				"--out-itf",
				output,
				"--verbosity",
				"0",
			],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(
				`Quint graph generation failed\n${result.stdout}${result.stderr}`,
			);
		const trace = JSON.parse(readFileSync(output, "utf8")) as JsonRecord;
		const graph = stateGraphFromQuintTrace(trace);
		const text = `${JSON.stringify(graph)}\n`;
		if (write) writeFileSync(fixture, text);
		else if (readFileSync(fixture, "utf8") !== text) {
			throw new Error(
				"The checked reducer graph differs from the Quint model. Review the change, then regenerate with --write.",
			);
		}
		console.log(
			`InteractiveTask graph checked with ${graph.states.length} states and ${graph.next.reduce((count, edges) => count + edges.length, 0)} edges`,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
