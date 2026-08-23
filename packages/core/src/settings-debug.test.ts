import { describe, expect, it } from "vitest";
import {
	sanitizeDebugString,
	sanitizeForSettingsDebug,
	settingsDebugCloudSummary,
} from "./settings-debug.ts";

describe("sanitizeDebugString", () => {
	it("returns empty string for blank input", () => {
		expect(sanitizeDebugString("")).toBe("");
		expect(sanitizeDebugString("   ")).toBe("");
	});

	it("keeps the [REDACTED] sentinel verbatim (case-insensitive)", () => {
		expect(sanitizeDebugString("[REDACTED]")).toBe("[REDACTED]");
		expect(sanitizeDebugString("  [redacted]  ")).toBe("[REDACTED]");
	});

	it("masks secret-shaped strings by prefix", () => {
		expect(sanitizeDebugString("sk-proj-abcdef123456")).toBe(
			"sk-p…56 (20 chars)",
		);
		expect(sanitizeDebugString("pk_live_abcdefghijkl")).toBe(
			"pk_l…kl (20 chars)",
		);
		expect(sanitizeDebugString("Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(
			"Bear…J9 (27 chars)",
		);
	});

	it("masks any value longer than 48 chars with a preview", () => {
		const masked = sanitizeDebugString("a".repeat(60));
		expect(masked).toMatch(/^aaaa…aa \(\d+ chars\)$/);
		const maskedLong = sanitizeDebugString("a".repeat(200));
		expect(maskedLong).toMatch(/^aaaa…aa \(\d+ chars\)$/);
	});

	it("keeps short non-secret strings intact", () => {
		expect(sanitizeDebugString("hello world")).toBe("hello world");
		expect(sanitizeDebugString("  padded value  ")).toBe("padded value");
	});
});

describe("sanitizeForSettingsDebug", () => {
	it("redacts values under sensitive snake_case keys", () => {
		const out = sanitizeForSettingsDebug({
			api_key: "sk-live-1234567890abcdef",
			openai_api_key: "sk-proj-1234567890",
			private_key: "0x1234",
			authorization: "Bearer abc123",
			cookie: "sid=abc",
			mnemonic: "word word word",
		});
		expect(out.api_key).not.toBe("sk-live-1234567890abcdef");
		expect(out.openai_api_key).not.toBe("sk-proj-1234567890");
		expect(out.private_key).not.toBe("0x1234");
		expect(out.authorization).not.toBe("Bearer abc123");
		expect(out.cookie).not.toBe("sid=abc");
		expect(out.mnemonic).not.toBe("word word word");
	});

	it("redacts values under camelCase sensitive keys (accessToken etc.)", () => {
		const out = sanitizeForSettingsDebug({
			accessToken: "access-tok-123",
			refreshToken: "refresh-tok-456",
			authToken: "auth-tok-789",
			userPassword: "hunter2",
			secretKey: "secret-key-1",
			sessionKey: "session-key-2",
			openaiApiKey: "sk-abc-def",
		});
		expect(out.accessToken).not.toBe("access-tok-123");
		expect(out.refreshToken).not.toBe("refresh-tok-456");
		expect(out.authToken).not.toBe("auth-tok-789");
		expect(out.userPassword).not.toBe("hunter2");
		expect(out.secretKey).not.toBe("secret-key-1");
		expect(out.sessionKey).not.toBe("session-key-2");
		expect(out.openaiApiKey).not.toBe("sk-abc-def");
	});

	it("keeps non-sensitive camelCase keys untouched", () => {
		const out = sanitizeForSettingsDebug({
			maxTokens: 2048,
			tokenize: "no",
			model: "gpt-4o",
			topP: 0.9,
		});
		expect(out.maxTokens).toBe(2048);
		expect(out.tokenize).toBe("no");
		expect(out.model).toBe("gpt-4o");
		expect(out.topP).toBe(0.9);
	});

	it("caps array length and reports overflow", () => {
		const arr = Array.from({ length: 50 }, (_, i) => i);
		const out = sanitizeForSettingsDebug({ items: arr });
		expect(out.items).toHaveLength(41);
		expect(out.items[40]).toBe("… +10 more");
	});

	it("stops at MAX_DEPTH", () => {
		let obj: Record<string, unknown> = { leaf: "x" };
		for (let i = 0; i < 20; i++) obj = { nested: obj };
		const out = sanitizeForSettingsDebug(obj);
		// The [max-depth] sentinel appears at the deepest expanded node.
		let node: unknown = out;
		while (
			node &&
			typeof node === "object" &&
			"nested" in (node as Record<string, unknown>)
		) {
			node = (node as Record<string, unknown>).nested;
		}
		expect(node).toBe("[max-depth]");
	});

	it("handles circular references", () => {
		const obj: Record<string, unknown> = { name: "x" };
		obj.self = obj;
		const out = sanitizeForSettingsDebug(obj);
		expect(out.self).toBe("[circular]");
	});

	it("passes through primitives", () => {
		expect(sanitizeForSettingsDebug(null)).toBeNull();
		expect(sanitizeForSettingsDebug(undefined)).toBeUndefined();
		expect(sanitizeForSettingsDebug(true)).toBe(true);
		expect(sanitizeForSettingsDebug(42)).toBe(42);
		expect(sanitizeForSettingsDebug(123n)).toBe("123");
		expect(sanitizeForSettingsDebug(() => 1)).toBe("[fn anonymous]");
	});
});

describe("settingsDebugCloudSummary", () => {
	it("never exposes the raw api key", () => {
		const summary = settingsDebugCloudSummary({
			enabled: true,
			apiKey: "sk-live-super-secret-123",
			inferenceMode: "hybrid",
			baseUrl: "https://example.com",
			services: ["chat"],
		});
		expect(summary).toEqual({
			enabled: true,
			inferenceMode: "hybrid",
			baseUrl: "https://example.com",
			services: ["chat"],
			hasApiKey: true,
		});
		expect(JSON.stringify(summary)).not.toContain("sk-live");
	});

	it("reports missing api key and non-object input", () => {
		expect(settingsDebugCloudSummary({}).hasApiKey).toBe(false);
		expect(settingsDebugCloudSummary(null)).toEqual({ cloud: null });
		expect(settingsDebugCloudSummary("nope")).toEqual({ cloud: null });
	});
});
