/** Exercises Browser launch delivery through the real caller-owned navigation request contract. */

import type { Memory } from "@elizaos/core";
import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLaunchUrlInBrowserView } from "./browser-view-navigation.js";

const originalFetch = globalThis.fetch;

function setFetch(mock: ReturnType<typeof vi.fn>): void {
	globalThis.fetch = mock as typeof fetch;
}

function message(clientId?: string, voice = false): Memory {
	return {
		content: {
			text: "launch demo",
			metadata: {
				...(clientId ? { viewClientId: clientId } : {}),
				...(voice ? { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT } : {}),
			},
		},
	} as Memory;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Browser launch navigation", () => {
	it("targets the originating app renderer and trusts only its matching receipt", async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						ok: true,
						completedActionDelivered: true,
						completedActionHandoffId: body.completedActionHandoffId,
					}),
					{ status: 200 },
				);
			},
		);
		setFetch(fetchMock);

		const result = await openLaunchUrlInBrowserView(
			"/api/apps/local/demo/",
			message("client-a"),
		);

		const body = JSON.parse(
			String(fetchMock.mock.calls[0]?.[1]?.body),
		) as Record<string, unknown>;
		expect(body).toMatchObject({
			clientId: "client-a",
			delivery: "completed-action",
			path: "/browser?browse=%2Fapi%2Fapps%2Flocal%2Fdemo%2F",
		});
		expect(body.completedActionHandoffId).toEqual(expect.any(String));
		expect(result).toMatchObject({
			status: "renderer-delivered",
			openedInBrowser: true,
			completedActionDelivered: true,
			completedActionHandoffId: body.completedActionHandoffId,
		});
	});

	it("uses the completed action without issuing a global request when no client id exists", async () => {
		const fetchMock = vi.fn();
		setFetch(fetchMock);

		const result = await openLaunchUrlInBrowserView(
			"/api/apps/local/demo/",
			message(),
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "terminal-fallback",
			openedInBrowser: false,
			completedActionHandoffId: expect.any(String),
		});
	});

	it.each([
		[
			"stale renderer",
			new Response('{"ok":true,"completedActionDelivered":false}', {
				status: 200,
			}),
			undefined,
		],
		[
			"malformed receipt",
			new Response("{", { status: 200 }),
			"malformed-receipt",
		],
	] as const)(
		"retains terminal fallback for a %s",
		async (_name, response, failure) => {
			setFetch(vi.fn(async () => response));
			const result = await openLaunchUrlInBrowserView(
				"/api/apps/local/demo/",
				message("client-stale"),
			);
			expect(result).toMatchObject({
				status: "terminal-fallback",
				openedInBrowser: false,
				completedActionHandoffId: expect.any(String),
				...(failure ? { navigationFailure: failure } : {}),
			});
		},
	);

	it("reports a timed-out early delivery while preserving terminal fallback", async () => {
		setFetch(
			vi.fn(async () => {
				throw new DOMException("timed out", "TimeoutError");
			}),
		);
		const result = await openLaunchUrlInBrowserView(
			"/api/apps/local/demo/",
			message("client-timeout"),
		);
		expect(result).toMatchObject({
			status: "terminal-fallback",
			openedInBrowser: false,
			navigationFailure: "transport-error",
		});
	});

	it("uses originating-client delivery for voice and never creates a terminal handoff", async () => {
		const fetchMock = vi.fn(
			async () => new Response('{"ok":true}', { status: 200 }),
		);
		setFetch(fetchMock);
		const result = await openLaunchUrlInBrowserView(
			"/api/apps/local/demo/",
			message("voice-client", true),
		);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body).toMatchObject({
			clientId: "voice-client",
			delivery: "originating-client",
		});
		expect(body).not.toHaveProperty("completedActionHandoffId");
		expect(result).toMatchObject({
			status: "renderer-delivered",
			openedInBrowser: true,
		});
		expect(result).not.toHaveProperty("completedActionHandoffId");
	});

	it("keeps concurrent renderer requests isolated", async () => {
		const bodies: Record<string, unknown>[] = [];
		setFetch(
			vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				bodies.push(body);
				return new Response(
					JSON.stringify({
						ok: true,
						completedActionDelivered: true,
						completedActionHandoffId: body.completedActionHandoffId,
					}),
					{ status: 200 },
				);
			}),
		);

		const [first, second] = await Promise.all([
			openLaunchUrlInBrowserView("/api/apps/local/one/", message("client-one")),
			openLaunchUrlInBrowserView("/api/apps/local/two/", message("client-two")),
		]);

		expect(bodies.map((body) => body.clientId).sort()).toEqual([
			"client-one",
			"client-two",
		]);
		expect(first.completedActionHandoffId).not.toBe(
			second.completedActionHandoffId,
		);
	});

	it("rejects malformed launch URLs before delivery", async () => {
		const fetchMock = vi.fn();
		setFetch(fetchMock);
		await expect(
			openLaunchUrlInBrowserView("http://[", message("client-a")),
		).resolves.toEqual({ status: "invalid-url", openedInBrowser: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
