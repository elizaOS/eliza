import type { SubscriptionStatusResponse } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	composeSubscriptionStatusSnapshot,
	readSubscriptionStatusViaHttp,
	type SubscriptionStatusReader,
} from "./subscription-rpc";

function mockFetchJson(status: number, body: unknown) {
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	);
	const replacement: typeof fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
		{ preconnect: globalThis.fetch.preconnect },
	);
	globalThis.fetch = replacement;
	return fetchMock;
}

const subscriptionStatus: SubscriptionStatusResponse = {
	providers: [
		{
			provider: "anthropic-subscription",
			accountId: "default",
			label: "Claude",
			configured: true,
			valid: true,
			expiresAt: null,
			source: "app",
			available: true,
			allowedClient: "claude-code",
			billingMode: "subscription-coding-plan",
		},
		{
			provider: "anthropic-subscription",
			accountId: "setup-token",
			label: "Setup token",
			configured: true,
			valid: true,
			expiresAt: 1700000100000,
			source: "setup-token",
		},
	],
};

describe("getSubscriptionStatus typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		const reader: SubscriptionStatusReader = async () => subscriptionStatus;

		await expect(
			composeSubscriptionStatusSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards a valid subscription status payload", async () => {
		const reader: SubscriptionStatusReader = async () => subscriptionStatus;

		await expect(
			composeSubscriptionStatusSnapshot(31337, reader),
		).resolves.toEqual(subscriptionStatus);
	});

	it("reads and validates the HTTP subscription status payload", async () => {
		const fetchMock = mockFetchJson(200, subscriptionStatus);

		await expect(readSubscriptionStatusViaHttp(31337)).resolves.toEqual(
			subscriptionStatus,
		);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/api/subscription/status",
		);
	});

	it("returns null on malformed subscription status payloads", async () => {
		mockFetchJson(200, {
			providers: [
				{
					...subscriptionStatus.providers[0],
					valid: "yes",
				},
			],
		});

		await expect(readSubscriptionStatusViaHttp(31337)).resolves.toBeNull();
	});
});
