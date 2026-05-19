/**
 * IMAGE_DESCRIPTION fallback chain tests.
 *
 * Exercises the local→cloud→vast wrappers in isolation. The wrappers are
 * pure functions over an injected `fetch`, so we never touch global env
 * here — every knob is passed in via options.
 *
 * What we assert:
 *  - Local success: cloud `fetch` is never called.
 *  - Local fallback: cloud `fetch` is invoked with the right URL/body/auth.
 *  - Cloud 5xx: the cloud-wrapped handler re-emits a `{kind:"fallback"}` so
 *    the vast layer can take over; vast `fetch` is then invoked.
 *  - Both unavailable (no token / no key): the original local fallback
 *    propagates unchanged so an outer layer (or the runtime) can act.
 */

import type {
	ImageDescriptionParams,
	ImageDescriptionResult,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type LocalImageDescriptionHandler,
	type LocalVisionOutcome,
	wrapImageDescriptionHandlerWithCloudFallback,
} from "./cloud-fallback";
import { wrapImageDescriptionHandlerWithVastFallback } from "./vast-fallback";

// Quarantine the env vars the wrappers read so a developer machine that
// happens to have ELIZA_CLOUD_TOKEN / ELIZA_VAST_* exported doesn't make the
// "unconfigured" assertions flake into a real outbound HTTP call.
const ENV_KEYS = [
	"ELIZA_CLOUD_TOKEN",
	"ELIZA_CLOUD_API_KEY",
	"ELIZA_CLOUD_BASE_URL",
	"ELIZA_VAST_BASE_URL",
	"ELIZA_VAST_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

const PNG_URL = "https://example.invalid/cat.png";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function textResponse(body: string, status = 500): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/plain" },
	});
}

function okLocal(result: ImageDescriptionResult): LocalImageDescriptionHandler {
	return async () => result;
}

function fallbackLocal(
	reason: LocalVisionOutcome extends { kind: "fallback"; reason: infer R }
		? R
		: never,
): LocalImageDescriptionHandler {
	return async () =>
		({
			kind: "fallback",
			reason,
		}) satisfies LocalVisionOutcome;
}

describe("wrapImageDescriptionHandlerWithCloudFallback", () => {
	it("returns local result without invoking cloud when local succeeds", async () => {
		const fetchMock = vi.fn();
		const wrapped = wrapImageDescriptionHandlerWithCloudFallback(
			okLocal({ title: "Cat", description: "A small ginger cat." }),
			{ token: "tk_test", baseUrl: "https://cloud.test", fetch: fetchMock },
		);
		const result = await wrapped({
			imageUrl: PNG_URL,
		} as ImageDescriptionParams);
		expect(result).toEqual({
			title: "Cat",
			description: "A small ginger cat.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("invokes cloud /v1/vision/describe with bearer + body when local falls back", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				title: "Cloud title",
				description: "Cloud description.",
			}),
		);
		const wrapped = wrapImageDescriptionHandlerWithCloudFallback(
			fallbackLocal("local-unavailable"),
			{ token: "tk_test", baseUrl: "https://cloud.test", fetch: fetchMock },
		);
		const result = await wrapped({
			imageUrl: PNG_URL,
			prompt: "describe",
		} as ImageDescriptionParams);
		expect(result).toEqual({
			title: "Cloud title",
			description: "Cloud description.",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://cloud.test/v1/vision/describe");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer tk_test",
		);
		const body = JSON.parse(init.body as string) as {
			image: { kind: string; url: string };
			prompt: string;
		};
		expect(body.image).toEqual({ kind: "url", url: PNG_URL });
		expect(body.prompt).toBe("describe");
	});

	it("forwards URL inputs as-is (no local fetch first)", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ title: "T", description: "D" }),
		);
		const wrapped = wrapImageDescriptionHandlerWithCloudFallback(
			fallbackLocal("local-unavailable"),
			{ token: "tk_test", baseUrl: "https://cloud.test", fetch: fetchMock },
		);
		await wrapped({ imageUrl: PNG_URL } as ImageDescriptionParams);
		// Only one outbound call — to the cloud describe endpoint, not to the URL.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toBe("https://cloud.test/v1/vision/describe");
	});

	it("propagates fallback when no cloud token is configured", async () => {
		const fetchMock = vi.fn();
		const wrapped = wrapImageDescriptionHandlerWithCloudFallback(
			fallbackLocal("local-unavailable"),
			{ baseUrl: "https://cloud.test", fetch: fetchMock },
		);
		const out = await wrapped({ imageUrl: PNG_URL } as ImageDescriptionParams);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(out).toMatchObject({
			kind: "fallback",
			reason: "local-unavailable",
		});
	});

	it("propagates fallback when cloud responds with 5xx", async () => {
		const fetchMock = vi.fn(async () => textResponse("upstream down", 503));
		const wrapped = wrapImageDescriptionHandlerWithCloudFallback(
			fallbackLocal("local-error"),
			{ token: "tk_test", baseUrl: "https://cloud.test", fetch: fetchMock },
		);
		const out = await wrapped({ imageUrl: PNG_URL } as ImageDescriptionParams);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(out).toMatchObject({ kind: "fallback", reason: "local-error" });
		expect((out as { cause?: Error }).cause?.message ?? "").toContain("503");
	});
});

describe("wrapImageDescriptionHandlerWithVastFallback", () => {
	it("invokes vast when inner handler returns fallback and vast is configured", async () => {
		const innerFetch = vi.fn(async () => textResponse("cloud sad", 503));
		const inner = wrapImageDescriptionHandlerWithCloudFallback(
			fallbackLocal("local-unavailable"),
			{ token: "tk_test", baseUrl: "https://cloud.test", fetch: innerFetch },
		);
		const vastFetch = vi.fn(async () =>
			jsonResponse({ title: "VTitle", description: "VDescription" }),
		);
		const wrapped = wrapImageDescriptionHandlerWithVastFallback(inner, {
			baseUrl: "https://vast.test",
			apiKey: "vast_key",
			fetch: vastFetch,
		});
		const result = await wrapped({
			imageUrl: PNG_URL,
		} as ImageDescriptionParams);
		expect(innerFetch).toHaveBeenCalledTimes(1);
		expect(vastFetch).toHaveBeenCalledTimes(1);
		const [url, init] = vastFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://vast.test/v1/vision/describe");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer vast_key",
		);
		expect(result).toEqual({ title: "VTitle", description: "VDescription" });
	});

	it("does not call vast when inner handler succeeds", async () => {
		const inner = wrapImageDescriptionHandlerWithCloudFallback(
			okLocal({ title: "Local", description: "Local desc." }),
			{ token: "tk_test", baseUrl: "https://cloud.test", fetch: vi.fn() },
		);
		const vastFetch = vi.fn();
		const wrapped = wrapImageDescriptionHandlerWithVastFallback(inner, {
			baseUrl: "https://vast.test",
			apiKey: "vast_key",
			fetch: vastFetch,
		});
		const result = await wrapped({
			imageUrl: PNG_URL,
		} as ImageDescriptionParams);
		expect(vastFetch).not.toHaveBeenCalled();
		expect(result).toEqual({ title: "Local", description: "Local desc." });
	});

	it("propagates fallback when both cloud and vast are unconfigured", async () => {
		const inner = wrapImageDescriptionHandlerWithCloudFallback(
			fallbackLocal("local-unavailable"),
			{ fetch: vi.fn() },
		);
		const vastFetch = vi.fn();
		const wrapped = wrapImageDescriptionHandlerWithVastFallback(inner, {
			fetch: vastFetch,
		});
		const out = await wrapped({ imageUrl: PNG_URL } as ImageDescriptionParams);
		expect(vastFetch).not.toHaveBeenCalled();
		expect(out).toMatchObject({
			kind: "fallback",
			reason: "local-unavailable",
		});
	});
});
