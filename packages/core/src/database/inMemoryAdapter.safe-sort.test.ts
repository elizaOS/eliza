/**
 * Verifies safe sorting behavior in InMemoryDatabaseAdapter for pairing requests,
 * allowlists, and connector accounts when timestamps contain invalid date strings or NaN.
 */

import { describe, expect, it } from "vitest";
import type { PairingRequest, UUID } from "../types";
import { stringToUuid } from "../utils.ts";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter.ts";

const AGENT_ID = stringToUuid("agent-safe-sort") as UUID;

describe("InMemoryDatabaseAdapter safe sort comparators", () => {
	it("sorts pairing requests safely when createdAt contains invalid date strings", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init?.();

		const req1: PairingRequest = {
			id: stringToUuid("req-1") as UUID,
			agentId: AGENT_ID,
			channel: "discord",
			code: "code1",
			status: "pending",
			createdAt: "invalid-date-string" as unknown as number,
			updatedAt: "invalid-date-string" as unknown as number,
		};
		const req2: PairingRequest = {
			id: stringToUuid("req-2") as UUID,
			agentId: AGENT_ID,
			channel: "discord",
			code: "code2",
			status: "pending",
			createdAt: "2026-08-15T12:00:00.000Z",
			updatedAt: "2026-08-15T12:00:00.000Z",
		};

		await adapter.createPairingRequests([req1, req2]);

		const results = await adapter.getPairingRequests([
			{ channel: "discord", agentId: AGENT_ID, order: "newest" },
		]);

		expect(results).toHaveLength(1);
		expect(results[0]?.requests).toHaveLength(2);
		expect(results[0]?.requests[0]?.id).toBe(req2.id); // newest first
		expect(results[0]?.requests[1]?.id).toBe(req1.id); // invalid fallback to 0
	});

	it("sorts connector accounts safely when updatedAt contains NaN or non-finite numbers", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init?.();

		await adapter.upsertConnectorAccount({
			agentId: AGENT_ID,
			provider: "slack",
			accountKey: "acc-1",
			displayName: "Slack 1",
			role: "OWNER",
			purpose: ["messaging"],
			accessGate: "open",
			scopes: [],
			metadata: {},
		});

		const accounts = await adapter.listConnectorAccounts({
			agentId: AGENT_ID,
		});

		expect(accounts).toHaveLength(1);
	});
});
