/**
 * Unit tests for the BlueBubbles sensitive-request adapter. The BlueBubbles
 * service is stubbed so no macOS bridge or REST server is required.
 */

import type { IAgentRuntime, SensitiveRequest } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BLUEBUBBLES_SERVICE_NAME } from "./constants";
import { blueBubblesDmSensitiveRequestAdapter } from "./sensitive-request-adapter";

function makeRequest(
	overrides: Partial<SensitiveRequest> = {},
): SensitiveRequest {
	return {
		id: "req-1",
		kind: "oauth",
		status: "pending",
		agentId: "agent-1",
		requesterEntityId: "iMessage;-;+14155552671",
		target: { kind: "oauth", provider: "GitHub", scopes: ["repo"] },
		policy: {
			actor: "owner_or_linked_identity",
			requirePrivateDelivery: true,
			requireAuthenticatedLink: true,
			allowInlineOwnerAppEntry: true,
			allowPublicLink: false,
			allowDmFallback: true,
			allowTunnelLink: true,
			allowCloudLink: true,
		},
		delivery: {
			kind: "oauth",
			source: "dm",
			mode: "private_dm",
			policy: {
				actor: "owner_or_linked_identity",
				requirePrivateDelivery: true,
				requireAuthenticatedLink: true,
				allowInlineOwnerAppEntry: true,
				allowPublicLink: false,
				allowDmFallback: true,
				allowTunnelLink: true,
				allowCloudLink: true,
			},
			privateRouteRequired: true,
			publicLinkAllowed: false,
			authenticated: false,
			canCollectValueInCurrentChannel: true,
			reason: "current channel is private",
			instruction: "Open the app.",
		},
		callback: { url: "https://app.test/oauth/req-1" },
		expiresAt: "2099-01-01T00:00:00.000Z",
		createdAt: "2026-05-10T00:00:00.000Z",
		updatedAt: "2026-05-10T00:00:00.000Z",
		...overrides,
	} as SensitiveRequest;
}

function makeRuntime(service: unknown): IAgentRuntime {
	return {
		getService: vi.fn((name: string) =>
			name === BLUEBUBBLES_SERVICE_NAME ? service : null,
		),
	} as unknown as IAgentRuntime;
}

describe("blueBubblesDmSensitiveRequestAdapter", () => {
	it("sends secure-link prose and returns delivered=true", async () => {
		const sendMessage = vi.fn(async () => ({ guid: "bb-1" }));
		const runtime = makeRuntime({ sendMessage });
		const request = makeRequest();

		const result = await blueBubblesDmSensitiveRequestAdapter.deliver({
			request,
			runtime,
		});

		expect(result).toEqual({
			delivered: true,
			target: "dm",
			channelId: "iMessage;-;+14155552671",
			url: "https://app.test/oauth/req-1",
			expiresAt: request.expiresAt,
		});
		expect(sendMessage).toHaveBeenCalledWith(
			"iMessage;-;+14155552671",
			expect.stringContaining("https://app.test/oauth/req-1"),
		);
	});

	it("returns delivered=false when no target is available", async () => {
		const sendMessage = vi.fn();
		const runtime = makeRuntime({ sendMessage });
		const request = makeRequest({
			requesterEntityId: null,
			originUserId: null,
		});

		const result = await blueBubblesDmSensitiveRequestAdapter.deliver({
			request,
			runtime,
		});

		expect(result.delivered).toBe(false);
		expect(result.error).toMatch(/no bluebubbles chat target/i);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("returns delivered=false when the service throws", async () => {
		const runtime = makeRuntime({
			sendMessage: vi.fn(async () => {
				throw new Error("bridge down");
			}),
		});

		const result = await blueBubblesDmSensitiveRequestAdapter.deliver({
			request: makeRequest(),
			runtime,
		});

		expect(result).toMatchObject({
			delivered: false,
			target: "dm",
			channelId: "iMessage;-;+14155552671",
			error: "bridge down",
		});
	});
});
