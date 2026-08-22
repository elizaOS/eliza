/**
 * Verifies app launch navigation at the caller-owned loopback boundary with a
 * mocked HTTP transport and no renderer or network dependency.
 */

import type { Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appLaunchViewClientId,
	isRealtimeVoiceAppLaunch,
	openLaunchUrlInBrowserView,
} from "./browser-view-navigation.js";

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("app launch Browser navigation", () => {
	it("does not issue a global request without a valid originating client", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			openLaunchUrlInBrowserView("/api/apps/local/demo/"),
		).resolves.toMatchObject({
			status: "unavailable",
			completedActionDelivered: false,
			errorCode: "NO_ORIGINATING_CLIENT",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("requires an own delivered marker and matching handoff receipt", async () => {
		const fetchMock = vi.fn(async () =>
			response({
				ok: true,
				completedActionDelivered: true,
				completedActionHandoffId: "handoff-a",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			openLaunchUrlInBrowserView("/api/apps/local/demo/", {
				originatingClientId: "client-a",
				completedActionHandoffId: "handoff-a",
			}),
		).resolves.toMatchObject({
			status: "delivered",
			completedActionDelivered: true,
			completedActionHandoffId: "handoff-a",
		});
		const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(request).toMatchObject({
			delivery: "completed-action",
			clientId: "client-a",
			completedActionHandoffId: "handoff-a",
		});
	});

	it("retains the terminal fallback for a stale renderer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					ok: true,
					completedActionDelivered: false,
					completedActionHandoffId: "handoff-stale",
				}),
			),
		);

		await expect(
			openLaunchUrlInBrowserView("/api/apps/local/demo/", {
				originatingClientId: "stale-client",
				completedActionHandoffId: "handoff-stale",
			}),
		).resolves.toMatchObject({
			status: "fallback",
			completedActionDelivered: false,
			completedActionHandoffId: "handoff-stale",
		});
	});

	it("rejects malformed receipts and translates transport timeouts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not-json", { status: 200 })),
		);
		await expect(
			openLaunchUrlInBrowserView("/api/apps/local/demo/", {
				originatingClientId: "client-a",
			}),
		).resolves.toMatchObject({ errorCode: "INVALID_RECEIPT" });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("timed out", "TimeoutError");
			}),
		);
		await expect(
			openLaunchUrlInBrowserView("/api/apps/local/demo/", {
				originatingClientId: "client-a",
			}),
		).resolves.toMatchObject({ errorCode: "TRANSPORT_FAILURE" });
	});

	it("translates a malformed launch URL before any transport call", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			openLaunchUrlInBrowserView("http://[", {
				originatingClientId: "client-a",
			}),
		).resolves.toMatchObject({ errorCode: "INVALID_LAUNCH_URL" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("scopes concurrent requests to their respective clients", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				bodies.push(body);
				return response({
					ok: true,
					completedActionDelivered: true,
					completedActionHandoffId: body.completedActionHandoffId,
				});
			}),
		);

		await Promise.all([
			openLaunchUrlInBrowserView("/api/apps/local/a/", {
				originatingClientId: "client-a",
			}),
			openLaunchUrlInBrowserView("/api/apps/local/b/", {
				originatingClientId: "client-b",
			}),
		]);
		expect(bodies.map((body) => body.clientId).sort()).toEqual([
			"client-a",
			"client-b",
		]);
	});

	it("uses originating-client delivery for realtime voice", async () => {
		const fetchMock = vi.fn(async () => response({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			openLaunchUrlInBrowserView("/api/apps/local/demo/", {
				originatingClientId: "voice-client",
				realtimeVoice: true,
			}),
		).resolves.toMatchObject({
			status: "delivered",
			completedActionDelivered: true,
		});
		const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(request).toMatchObject({
			delivery: "originating-client",
			clientId: "voice-client",
		});
		expect(request).not.toHaveProperty("completedActionHandoffId");
	});

	it("reads only safe caller and voice metadata", () => {
		const message = {
			content: {
				metadata: {
					viewClientId: "client.1",
					clientTransport: "realtime_voice",
				},
			},
		} as Memory;
		expect(appLaunchViewClientId(message)).toBe("client.1");
		expect(isRealtimeVoiceAppLaunch(message)).toBe(true);
		expect(
			appLaunchViewClientId({
				content: { metadata: { viewClientId: "bad client" } },
			} as Memory),
		).toBeUndefined();
	});
});
