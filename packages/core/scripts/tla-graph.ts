/**
 * Converts a TLC `-dump dot` state graph into canonical JSON, so a test can
 * compare a TLA+ module's reachable graph with the code's own exploration.
 *
 * TLA+ values become JSON: strings, integers and booleans as themselves,
 * model values as their names, sequences and sets as arrays (sets sorted),
 * records and functions as objects. States are sorted by their JSON text;
 * `next[i]` lists the distinct successors of state i, without self-loops.
 */

export type TlaValue =
	| string
	| number
	| boolean
	| TlaValue[]
	| { [key: string]: TlaValue };

export interface StateGraph {
	variables: string[];
	states: Record<string, TlaValue>[];
	initial: number[];
	next: number[][];
}

/** Parses one TLA+ value as TLC prints it. */
export function parseTlaValue(text: string): TlaValue {
	let at = 0;
	const fail = (what: string): never => {
		throw new Error(`Cannot parse TLA+ value at ${at} (${what}): ${text}`);
	};
	const space = () => {
		while (/\s/.test(text[at] ?? "")) at++;
	};
	const eat = (token: string) => {
		space();
		if (!text.startsWith(token, at)) fail(`expected ${token}`);
		at += token.length;
	};
	const peek = (token: string) => {
		space();
		return text.startsWith(token, at);
	};
	const list = (close: string): TlaValue[] => {
		const items: TlaValue[] = [];
		if (peek(close)) {
			at += close.length;
			return items;
		}
		for (;;) {
			items.push(value());
			if (peek(close)) {
				at += close.length;
				return items;
			}
			eat(",");
		}
	};
	const key = (item: TlaValue) =>
		typeof item === "string" ? item : JSON.stringify(item);
	const value = (): TlaValue => {
		space();
		if (peek("<<")) {
			at += 2;
			return list(">>");
		}
		if (peek("{")) {
			at += 1;
			return list("}").sort((a, b) =>
				JSON.stringify(a).localeCompare(JSON.stringify(b)),
			);
		}
		if (peek("[")) {
			at += 1;
			const record: Record<string, TlaValue> = {};
			if (peek("]")) {
				at += 1;
				return record;
			}
			for (;;) {
				space();
				const name =
					/^[A-Za-z_][\w]*/.exec(text.slice(at))?.[0] ?? fail("field");
				at += name.length;
				eat("|->");
				record[name] = value();
				if (peek("]")) {
					at += 1;
					return record;
				}
				eat(",");
			}
		}
		if (peek("(")) {
			at += 1;
			const fn: Record<string, TlaValue> = {};
			for (;;) {
				const domain = value();
				eat(":>");
				fn[key(domain)] = value();
				if (peek(")")) {
					at += 1;
					return fn;
				}
				eat("@@");
			}
		}
		if (text[at] === '"') {
			const match = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(at)) ?? fail("string");
			at += match[0].length;
			return JSON.parse(match[0]) as string;
		}
		const atom = /^-?\w+/.exec(text.slice(at))?.[0] ?? fail("atom");
		at += atom.length;
		if (atom === "TRUE") return true;
		if (atom === "FALSE") return false;
		return /^-?\d+$/.test(atom) ? Number(atom) : atom;
	};
	const result = value();
	space();
	if (at !== text.length) fail("trailing text");
	return result;
}

/** Parses the `/\ name = value` lines of one TLC state label. */
function parseState(label: string): Record<string, TlaValue> {
	const state: Record<string, TlaValue> = {};
	for (const line of label.split("\n")) {
		const match = /^\/\\ (\w+) = (.*)$/.exec(line.trim());
		if (!match) throw new Error(`Unexpected TLC state line: ${line}`);
		state[match[1] as string] = parseTlaValue(match[2] as string);
	}
	return state;
}

/** Reads a TLC `-dump dot` file into a canonical state graph. */
export function stateGraphFromDot(dot: string): StateGraph {
	const unescapeLabel = (label: string) =>
		label.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
	const byId = new Map<string, Record<string, TlaValue>>();
	const initialIds = new Set<string>();
	const edges: [string, string][] = [];
	for (const line of dot.split("\n")) {
		const node = /^(-?\d+) \[label="((?:[^"\\]|\\.)*)"(.*)\];?$/.exec(line);
		if (node) {
			byId.set(node[1] as string, parseState(unescapeLabel(node[2] as string)));
			if ((node[3] as string).includes("filled"))
				initialIds.add(node[1] as string);
			continue;
		}
		const edge = /^(-?\d+) -> (-?\d+)/.exec(line);
		if (edge) edges.push([edge[1] as string, edge[2] as string]);
	}
	const text = new Map(
		[...byId].map(([id, state]) => [id, JSON.stringify(sortKeys(state))]),
	);
	const order = [...new Set(text.values())].sort();
	const index = new Map(order.map((json, i) => [json, i]));
	const indexOf = (id: string) => index.get(text.get(id) as string) as number;
	const next = order.map(() => new Set<number>());
	for (const [from, to] of edges) {
		const a = indexOf(from);
		const b = indexOf(to);
		if (a !== b) next[a]?.add(b);
	}
	const states = order.map(
		(json) => JSON.parse(json) as Record<string, TlaValue>,
	);
	return {
		variables: Object.keys(states[0] ?? {}),
		states,
		initial: [...initialIds].map(indexOf).sort((a, b) => a - b),
		next: next.map((set) => [...set].sort((a, b) => a - b)),
	};
}

function sortKeys(value: TlaValue): TlaValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortKeys(value[key] as TlaValue)]),
		);
	}
	return value;
}
