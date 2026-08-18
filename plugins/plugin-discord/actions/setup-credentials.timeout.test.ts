/**
 * Credential validation fetch deadlines — proves the production preset aborts on timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CREDENTIAL_VALIDATION_TIMEOUT_MS,
	getPreset,
} from "./setup-credentials";

describe("credential validation fetch timeout", () => {
	const originalFetch = globalThis.fetch;
	let origTimeout: typeof AbortSignal.timeout;

	beforeEach(() => {
		origTimeout = AbortSignal.timeout.bind(AbortSignal);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("exposes the documented 10s budget", () => {
		expect(DEFAULT_CREDENTIAL_VALIDATION_TIMEOUT_MS).toBe(10_000);
	});

	it("aborts a stalled credential validation at the deadline", async () => {
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
		const spy = vi.fn(async (_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				const sig = init?.signal as AbortSignal | undefined;
				if (!sig) throw new Error("signal missing credential validation");
				sig.addEventListener("abort", () => reject(sig.reason), { once: true });
			});
		});
		const prev = globalThis.fetch;
		globalThis.fetch = spy as unknown as typeof fetch;
		try {
			const preset = getPreset("github");
			if (!preset) throw new Error("preset missing github");
			const result = await preset.validate({ token: "test-token" });
			expect(result.valid).toBe(false);
			expect(result.error).toMatch(/TimeoutError|aborted/i);
			expect(spy).toHaveBeenCalledWith(
				expect.stringContaining("api.github.com"),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		} finally {
			globalThis.fetch = prev;
		}
	});

	it("aborts a stalled body while reading the validation response", async () => {
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
		const spy = vi.fn(async (_url: string, init?: RequestInit) => {
			if (!init?.signal) throw new Error("signal missing body stall");
			return new Promise<Response>((_resolve, reject) => {
				const sig = init.signal as AbortSignal | undefined;
				sig?.addEventListener("abort", () => reject(sig?.reason), {
					once: true,
				});
				// hang body
			});
		});
		const prev = globalThis.fetch;
		globalThis.fetch = spy as unknown as typeof fetch;
		try {
			const preset = getPreset("vercel");
			if (!preset) throw new Error("preset missing vercel");
			const result = await preset.validate({ token: "test-token" });
			expect(result.valid).toBe(false);
			expect(result.error).toMatch(/TimeoutError|aborted/i);
		} finally {
			globalThis.fetch = prev;
		}
	});

	it("sends the abort signal and succeeds on a fast upstream", async () => {
		const spy = vi.fn(async (_url: string, init?: RequestInit) => {
			if (!init?.signal) throw new Error("signal missing success");
			return new Response(JSON.stringify({ login: "test-user" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const prev = globalThis.fetch;
		globalThis.fetch = spy as unknown as typeof fetch;
		try {
			const preset = getPreset("github");
			if (!preset) throw new Error("preset missing github");
			const result = await preset.validate({ token: "test-token" });
			expect(result.valid).toBe(true);
			expect(result.identity).toBe("@test-user");
			expect(spy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			const sig = (spy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal as
				| AbortSignal
				| undefined;
			expect(sig?.aborted).toBe(false);
		} finally {
			globalThis.fetch = prev;
		}
	});

	it("surfaces a provider error from a completed upstream", async () => {
		const spy = vi.fn(
			async () => new Response("Service Unavailable", { status: 503 }),
		);
		const prev = globalThis.fetch;
		globalThis.fetch = spy as unknown as typeof fetch;
		try {
			const preset = getPreset("github");
			if (!preset) throw new Error("preset missing github");
			const result = await preset.validate({ token: "test-token" });
			expect(result.valid).toBe(false);
			expect(result.error).toMatch(/503/);
		} finally {
			globalThis.fetch = prev;
		}
	});

	it("keeps the deadline active and propagates 429 as success where applicable", async () => {
		const spy = vi.fn(async (_url: string, init?: RequestInit) => {
			if (!init?.signal) throw new Error("signal missing 429");
			return new Response("", { status: 429 });
		});
		const prev = globalThis.fetch;
		globalThis.fetch = spy as unknown as typeof fetch;
		try {
			const preset = getPreset("openai");
			if (!preset) throw new Error("preset missing openai");
			const result = await preset.validate({ apiKey: "test-key" });
			expect(result.valid).toBe(true);
			expect(spy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		} finally {
			globalThis.fetch = prev;
		}
	});
});
