/**
 * Deterministic unit test for codex-auth (plugin-codex-cli): the ChatGPT OAuth
 * cache loader/saver with malformed-input rejection, the atomic 0600 tmp+rename
 * write, the JWT exp-based expiry gate (with injected clock), and the lock /
 * refresh path. Uses injected deps; fs is mocked. No runtime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFs } = vi.hoisted(() => ({
	mockFs: {
		open: vi.fn(),
		readFile: vi.fn(),
		rename: vi.fn(),
		stat: vi.fn(),
		unlink: vi.fn(),
		writeFile: vi.fn(),
	},
}));
vi.mock("node:fs/promises", () => ({ default: mockFs, ...mockFs }));
vi.mock("node:crypto", () => ({ randomBytes: () => Buffer.from("aabbccdd", "hex") }));
vi.mock("node:os", () => ({ homedir: () => "/home/fake" }));
vi.mock("node:path", () => ({ join: (...parts: string[]) => parts.join("/") }));

import {
	__resetCodexAuthDeps,
	__setCodexAuthDeps,
	type CodexAuth,
	defaultAuthPath,
	isExpired,
	loadCodexAuth,
	refreshCodexAuth,
	saveCodexAuth,
} from "./codex-auth.ts";

/** base64url encode a JSON payload for a fake JWT. */
function b64url(input: string): string {
	return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeAccessToken(exp: number | undefined): string {
	const payload = exp === undefined ? {} : { exp };
	return `header.${b64url(JSON.stringify(payload))}.sig`;
}

function makeAuth(overrides: Partial<CodexAuth> = {}): CodexAuth {
	return {
		OPENAI_API_KEY: null,
		auth_mode: "chatgpt",
		last_refresh: "2026-01-01T00:00:00.000Z",
		tokens: {
			id_token: "id",
			access_token: fakeAccessToken(Date.now() / 1000 + 3600),
			refresh_token: "refresh",
			account_id: "acct",
		},
		...overrides,
	};
}

beforeEach(() => {
	__resetCodexAuthDeps();
	vi.clearAllMocks();
	for (const fn of Object.values(mockFs)) {
		fn.mockReset();
	}
});

describe("defaultAuthPath", () => {
	it("points into ~/.codex/auth.json", () => {
		expect(defaultAuthPath()).toBe("/home/fake/.codex/auth.json");
	});
});

describe("loadCodexAuth — malformed-input rejection", () => {
	it("throws when tokens or access/refresh token are missing", async () => {
		mockFs.readFile.mockResolvedValue('{"OPENAI_API_KEY":"k"}');
		await expect(loadCodexAuth("/p/auth.json")).rejects.toThrow(/malformed/);
		mockFs.readFile.mockResolvedValue('{"tokens":{"id_token":"x"}}');
		await expect(loadCodexAuth("/p/auth.json")).rejects.toThrow(/malformed/);
	});

	it("rejects non-object JSON roots", async () => {
		mockFs.readFile.mockResolvedValue('"just a string"');
		await expect(loadCodexAuth("/p/auth.json")).rejects.toThrow(/malformed/);
	});

	it("normalizes a valid auth document", async () => {
		mockFs.readFile.mockResolvedValue(
			JSON.stringify({
				OPENAI_API_KEY: "sk-123",
				auth_mode: "apikey",
				last_refresh: "2026-02-02T00:00:00.000Z",
				tokens: { id_token: "i", access_token: "a", refresh_token: "r", account_id: "c" },
			}),
		);
		const auth = await loadCodexAuth("/p/auth.json");
		expect(auth.OPENAI_API_KEY).toBe("sk-123");
		expect(auth.auth_mode).toBe("apikey");
		expect(auth.last_refresh).toBe("2026-02-02T00:00:00.000Z");
		expect(auth.tokens.access_token).toBe("a");
	});

	it("fills missing optional fields with safe defaults", async () => {
		mockFs.readFile.mockResolvedValue(
			JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }),
		);
		const auth = await loadCodexAuth("/p/auth.json");
		expect(auth.OPENAI_API_KEY).toBeNull();
		expect(auth.auth_mode).toBe("chatgpt");
		expect(auth.tokens.id_token).toBe("");
		expect(auth.tokens.account_id).toBe("");
		expect(auth.last_refresh).toBe(new Date(0).toISOString());
	});
});

describe("saveCodexAuth — atomic write", () => {
	it("writes a 0600 tmp file then renames it into place", async () => {
		const auth = makeAuth();
		await saveCodexAuth(auth, "/p/auth.json");
		expect(mockFs.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(/^\/p\/auth\.json\.tmp\.\d+\.aabbccdd$/),
			expect.stringContaining('"access_token"'),
			{ mode: 0o600 },
		);
		expect(mockFs.rename).toHaveBeenCalledWith(
			expect.stringMatching(/tmp\./),
			"/p/auth.json",
		);
	});

	it("cleans up the tmp file when the rename fails", async () => {
		mockFs.rename.mockRejectedValue(new Error("EBUSY"));
		await expect(saveCodexAuth(makeAuth(), "/p/auth.json")).rejects.toThrow("EBUSY");
		expect(mockFs.unlink).toHaveBeenCalledWith(expect.stringMatching(/tmp\./));
	});
});

describe("isExpired — JWT expiry gate", () => {
	const NOW = 1_800_000_000_000; // fixed clock, ms

	it("treats an unexpired token as fresh", () => {
		__setCodexAuthDeps({ now: () => NOW });
		const auth = makeAuth({ tokens: { ...makeAuth().tokens, access_token: fakeAccessToken(NOW / 1000 + 600) } });
		expect(isExpired(auth)).toBe(false);
	});

	it("treats an expired token as expired", () => {
		__setCodexAuthDeps({ now: () => NOW });
		const auth = makeAuth({ tokens: { ...makeAuth().tokens, access_token: fakeAccessToken(NOW / 1000 - 10) } });
		expect(isExpired(auth)).toBe(true);
	});

	it("applies the buffer window: token within bufferSeconds is expired", () => {
		__setCodexAuthDeps({ now: () => NOW });
		const auth = makeAuth({ tokens: { ...makeAuth().tokens, access_token: fakeAccessToken(NOW / 1000 + 30) } });
		expect(isExpired(auth, 60)).toBe(true);
		expect(isExpired(auth, 10)).toBe(false);
	});

	it("treats a missing exp claim as expired", () => {
		__setCodexAuthDeps({ now: () => NOW });
		const auth = makeAuth({ tokens: { ...makeAuth().tokens, access_token: fakeAccessToken(undefined) } });
		expect(isExpired(auth)).toBe(true);
	});

	it("treats a non-numeric exp as expired", () => {
		__setCodexAuthDeps({ now: () => NOW });
		const junk = `header.${b64url(JSON.stringify({ exp: "soon" }))}.sig`;
		const auth = makeAuth({ tokens: { ...makeAuth().tokens, access_token: junk } });
		expect(isExpired(auth)).toBe(true);
	});

	it("treats a malformed token as expired", () => {
		const auth = makeAuth({ tokens: { ...makeAuth().tokens, access_token: "not-a-jwt" } });
		expect(isExpired(auth)).toBe(true);
	});
});

describe("refreshCodexAuth — lock + refresh path", () => {
	it("reuses the on-disk auth when it is still fresh", async () => {
		const fresh = makeAuth();
		mockFs.open.mockResolvedValue({
			writeFile: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		});
		mockFs.readFile.mockResolvedValue(JSON.stringify(fresh));
		const out = await refreshCodexAuth(makeAuth(), "/p/auth.json");
		expect(out).toEqual(fresh);
		expect(mockFs.unlink).toHaveBeenCalledWith("/p/auth.json.lock");
	});

	it("refreshes via the token endpoint and persists the result", async () => {
		mockFs.open.mockResolvedValue({
			writeFile: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		});
		// On-disk auth is expired -> triggers refresh.
		const expired = makeAuth({
			last_refresh: "2020-01-01T00:00:00.000Z",
			tokens: { ...makeAuth().tokens, access_token: fakeAccessToken(1_000) },
		});
		mockFs.readFile.mockResolvedValue(JSON.stringify(expired));
		__setCodexAuthDeps({
			now: () => 1_800_000_000_000,
			fetch: vi.fn(async () => ({
				ok: true,
				json: async () => ({ access_token: "new-access", refresh_token: "new-refresh" }),
			})),
		});
		const out = await refreshCodexAuth(expired, "/p/auth.json");
		expect(out.tokens.access_token).toBe("new-access");
		expect(out.tokens.refresh_token).toBe("new-refresh");
		expect(mockFs.writeFile).toHaveBeenCalled();
		expect(mockFs.rename).toHaveBeenCalledWith(expect.stringMatching(/tmp\./), "/p/auth.json");
	});

	it("throws when the refresh endpoint returns a non-OK status", async () => {
		mockFs.open.mockResolvedValue({
			writeFile: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		});
		const expired = makeAuth({
			tokens: { ...makeAuth().tokens, access_token: fakeAccessToken(1_000) },
		});
		mockFs.readFile.mockRejectedValue(new Error("ENOENT")); // fall back to current auth
		__setCodexAuthDeps({
			now: () => 1_800_000_000_000,
			fetch: vi.fn(async () => ({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: async () => "invalid_grant",
			})),
		});
		await expect(refreshCodexAuth(expired, "/p/auth.json")).rejects.toThrow(
			/refresh failed: 401/,
		);
	});

	it("throws when the refresh response lacks an access_token", async () => {
		mockFs.open.mockResolvedValue({
			writeFile: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		});
		const expired = makeAuth({
			tokens: { ...makeAuth().tokens, access_token: fakeAccessToken(1_000) },
		});
		mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
		__setCodexAuthDeps({
			now: () => 1_800_000_000_000,
			fetch: vi.fn(async () => ({
				ok: true,
				json: async () => ({ id_token: "only-id" }),
			})),
		});
		await expect(refreshCodexAuth(expired, "/p/auth.json")).rejects.toThrow(
			/missing access_token/,
		);
	});
});
