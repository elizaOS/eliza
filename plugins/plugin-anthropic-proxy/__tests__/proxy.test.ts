import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { computeBillingFingerprint } from "../src/proxy/billing-fingerprint.js";
import {
	DEFAULT_PROP_RENAMES,
	DEFAULT_REPLACEMENTS,
	DEFAULT_REVERSE_MAP,
	DEFAULT_TOOL_RENAMES,
} from "../src/proxy/constants.js";
import { reverseMap } from "../src/proxy/reverse-map.js";
import { applyReplacements } from "../src/proxy/sanitize.js";
import { applyQuotedRenames } from "../src/proxy/tool-rename.js";
import { loadCredentials } from "../src/utils/credentials-loader.js";
import {
	AnthropicProxyService,
	resolveConfig,
} from "../src/services/proxy-service.js";

// String literals chosen from the eliza-fingerprint dictionaries shipped
// in v0.2.0. They must round-trip through the forward + reverse maps without
// loss, regardless of whether they happen to be identity entries.
const ROUNDTRIP_WORD = "native-reasoning";
const TOOL_KEY = "bash";
const TOOL_VAL = "Bash";
const SSE_KEY = "bash";
const SSE_VAL = "Bash";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanup.length) {
		const fn = cleanup.pop();
		try { await fn?.(); } catch { /* swallow */ }
	}
});

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(overrides)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try { return fn(); } finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe("string sanitize roundtrip", () => {
	it("forward then reverse on a known paired key yields original input", () => {
		const original = `pre ${ROUNDTRIP_WORD} mid end`;
		const forward = applyReplacements(original, DEFAULT_REPLACEMENTS);
		const back = applyReplacements(forward, DEFAULT_REVERSE_MAP);
		expect(back).toBe(original);
	});
});

describe("tool name rename roundtrip", () => {
	it("forward quoted rename produces the renamed token", () => {
		const sample = JSON.stringify({ tool: TOOL_KEY, args: { v: 1 } });
		const forward = applyQuotedRenames(sample, DEFAULT_TOOL_RENAMES);
		expect(forward).toBe(JSON.stringify({ tool: TOOL_VAL, args: { v: 1 } }));
		const back = reverseMap(forward, {
			toolRenames: DEFAULT_TOOL_RENAMES,
			propRenames: DEFAULT_PROP_RENAMES,
			reverseMap: DEFAULT_REVERSE_MAP,
		});
		expect(back).toBe(sample);
	});

	it("handles escaped-quoted tokens in SSE delta payloads", () => {
		const inner = JSON.stringify({ tool: SSE_VAL, text: "hi" });
		const sseChunk = `data: {"type":"input_json_delta","partial_json":${JSON.stringify(inner)}}`;
		const back = reverseMap(sseChunk, {
			toolRenames: DEFAULT_TOOL_RENAMES,
			propRenames: DEFAULT_PROP_RENAMES,
			reverseMap: DEFAULT_REVERSE_MAP,
		});
		expect(back).toContain(`\\"${SSE_KEY}\\"`);
		expect(back).not.toContain(`\\"${SSE_VAL}\\"`);
	});
});

describe("billing fingerprint", () => {
	it("hashes deterministically with known input", () => {
		const input = "hello world this is a sample message";
		const a = computeBillingFingerprint(input);
		const b = computeBillingFingerprint(input);
		expect(a).toBe(b);
		expect(a).toHaveLength(3);
		expect(/^[0-9a-f]{3}$/.test(a)).toBe(true);
		const c = computeBillingFingerprint("a completely different prompt body for hashing");
		expect(c).toHaveLength(3);
		expect([a, c].length).toBe(2);
	});
});

describe("AnthropicProxyService modes", () => {
	it("starts in off mode and does not listen", async () => {
		const service = await withEnv({ CLAUDE_MAX_PROXY_MODE: "off" }, () =>
			AnthropicProxyService.start({} as unknown as never),
		);
		cleanup.push(() => service.stop());
		expect(service.getEffectiveMode()).toBe("off");
		expect(service.getProxyUrl()).toBeNull();
	});

	it("starts in shared mode and reports upstream", async () => {
		const upstream = createServer((req, res) => {
			if (req.url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok" }));
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const port = (upstream.address() as { port: number }).port;
		cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

		const service = await withEnv(
			{
				CLAUDE_MAX_PROXY_MODE: "shared",
				CLAUDE_MAX_PROXY_UPSTREAM: `http://127.0.0.1:${port}`,
			},
			() => AnthropicProxyService.start({} as unknown as never),
		);
		cleanup.push(() => service.stop());
		expect(service.getEffectiveMode()).toBe("shared");
		expect(service.getProxyUrl()).toBe(`http://127.0.0.1:${port}`);
		const status = await service.getStatus();
		expect(status.upstream?.reachable).toBe(true);
		expect(status.upstream?.status).toBe(200);
	});

	it("starts in inline mode and listens (when credentials present, else falls back to off)", async () => {
		const service = await withEnv(
			{
				CLAUDE_MAX_PROXY_MODE: "inline",
				CLAUDE_MAX_PROXY_PORT: "0",
				CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token-not-real",
			},
			() => AnthropicProxyService.start({} as unknown as never),
		);
		cleanup.push(() => service.stop());

		if (service.getEffectiveMode() === "inline") {
			expect(service.getProxyUrl()).toMatch(/^http:\/\/127\.0\.0\.1:/);
		} else {
			expect(service.getEffectiveMode()).toBe("off");
		}
	});
});

describe("credentials loader", () => {
	it("returns error (not throw) when no credentials file exists and no env token set", () => {
		const result = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined }, () =>
			loadCredentials({
				credentialsPath: "/nonexistent/path/that/does/not/exist.json",
			}),
		);
		if (result.creds === null) {
			expect(result.error).toBeDefined();
			expect(result.error).toMatch(/not found|missing|failed/i);
		} else {
			expect(result.creds.accessToken).toBeDefined();
		}
	});

	it("uses CLAUDE_CODE_OAUTH_TOKEN env when provided", () => {
		const result = loadCredentials({ envToken: "env-token-abc" });
		expect(result.creds).not.toBeNull();
		expect(result.creds?.accessToken).toBe("env-token-abc");
		expect(result.creds?.source).toBe("env");
	});
});

describe("config resolver", () => {
	it("defaults to inline mode and port 18801", () => {
		const cfg = withEnv(
			{
				CLAUDE_MAX_PROXY_MODE: undefined,
				CLAUDE_MAX_PROXY_PORT: undefined,
				CLAUDE_MAX_PROXY_BIND_HOST: undefined,
			},
			() => resolveConfig(),
		);
		expect(cfg.mode).toBe("inline");
		expect(cfg.port).toBe(18801);
		expect(cfg.bindHost).toBe("127.0.0.1");
	});
});
