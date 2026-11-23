/**
 * Replays quint/ProxyClientElements.qnt as real HTTP requests to a loopback
 * node:http listener whose handler calls isTrustedLocalRequest. Each request
 * carries the X-Forwarded-For value a same-machine proxy forwards: the
 * client's own elements, then the address the proxy saw, appended as a plain
 * element (nginx `$proxy_add_x_forwarded_for`), with the loopback upstream
 * Host nginx sends by default.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTrustedLocalRequest } from "../src/security/loopback-trust";

const KINDS = {
	plainLoopback: "127.0.0.1",
	forLoopback: "for=127.0.0.1",
	forQuotedLoopback6: 'for="[::1]:4000"',
	unknown: "unknown",
	forRemote: "for=198.51.100.7",
	lookalike: "xfor=127.0.0.1",
} as const;
type Kind = keyof typeof KINDS;
const ORIGINS = {
	local4: "127.0.0.1",
	local6: "::1",
	remote4: "203.0.113.5",
	remote6: "2001:db8::7",
} as const;
type Origin = keyof typeof ORIGINS;
const ACTIONS = ["compose", "send"] as const;
type Action = (typeof ACTIONS)[number];
/** verdict: 0 no request yet, 1 trusted as same-machine, 2 refused. */
interface ModelStep {
	action: Action;
	kind?: Kind;
	origin?: Origin;
	sent: Kind[];
	verdict: number;
}
type ModelCase = ModelStep[];

const compose = (kind: Kind, sent: Kind[], verdict: number): ModelStep => ({
	action: "compose",
	kind,
	sent,
	verdict,
});
const send = (origin: Origin, sent: Kind[], verdict: number): ModelStep => ({
	action: "send",
	origin,
	sent,
	verdict,
});

// Without generated cases, each first action replays these sequences.
const DEFAULT_CASES: ModelCase[] = [
	[
		compose("forLoopback", ["forLoopback"], 0),
		send("remote4", ["forLoopback"], 2),
		send("local4", ["forLoopback"], 1),
	],
	[
		compose("forQuotedLoopback6", ["forQuotedLoopback6"], 0),
		send("remote6", ["forQuotedLoopback6"], 2),
		compose("plainLoopback", ["forQuotedLoopback6", "plainLoopback"], 2),
		send("local6", ["forQuotedLoopback6", "plainLoopback"], 1),
	],
	[
		compose("forLoopback", ["forLoopback"], 0),
		compose("lookalike", ["forLoopback", "lookalike"], 0),
		send("local4", ["forLoopback", "lookalike"], 2),
	],
	[
		send("remote4", [], 2),
		compose("unknown", ["unknown"], 2),
		send("local6", ["unknown"], 1),
		compose("forRemote", ["forRemote", "unknown"], 1),
		send("local4", ["forRemote", "unknown"], 2),
	],
];
const generated = process.env.ELIZA_PROXY_CLIENT_ELEMENTS_MODEL_CASES;
const cases: ModelCase[] = generated
	? JSON.parse(readFileSync(generated, "utf8"))
	: DEFAULT_CASES;

let server: http.Server;
let port = 0;
const verdicts: boolean[] = [];

beforeAll(async () => {
	server = http.createServer((req, res) => {
		verdicts.push(
			isTrustedLocalRequest(req, {
				localAuthRequired: false,
				cloudProvisioned: false,
			}),
		);
		res.end("ok");
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function throughProxy(forwardedFor: string): Promise<number> {
	verdicts.length = 0;
	await new Promise<void>((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: "/api/status",
				headers: {
					host: `127.0.0.1:${port}`,
					"x-forwarded-for": forwardedFor,
				},
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve());
			},
		);
		req.on("error", reject);
		req.end();
	});
	expect(verdicts).toHaveLength(1);
	return verdicts[0] ? 1 : 2;
}

async function replay(modelCase: ModelCase): Promise<void> {
	// The client's elements in the order it added them.
	const elements: Kind[] = [];
	let verdict = 0;
	for (const [index, expected] of modelCase.entries()) {
		if (expected.action === "compose") {
			elements.push(expected.kind as Kind);
		} else {
			const origin = expected.origin as Origin;
			const value = [
				...elements.map((kind) => KINDS[kind]),
				ORIGINS[origin],
			].join(", ");
			verdict = await throughProxy(value);
		}
		const where = `step ${index + 1} (${expected.action}) of ${JSON.stringify(modelCase.map((item) => item.kind ?? item.origin))}`;
		expect([...elements].sort(), where).toEqual([...expected.sent].sort());
		expect(verdict, where).toBe(expected.verdict);
	}
}

describe("proxy client elements model", () => {
	it.each([...ACTIONS])(
		"replays the proxy client elements model from %s",
		async (first) => {
			const own = cases.filter((item) => item[0]?.action === first);
			expect(own.length).toBeGreaterThan(0);
			for (const modelCase of own) {
				await replay(modelCase);
			}
		},
		120_000,
	);
});
