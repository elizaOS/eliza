/** Verifies the core fallback adapter's bounded pairing query contract. */
import { describe, expect, it } from "vitest";
import type { PairingAllowlistEntry, PairingRequest, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "10000000-0000-0000-0000-000000000001" as UUID;

function id(index: number): UUID {
	return `10000000-0000-0000-0000-${index.toString().padStart(12, "0")}` as UUID;
}

function request(index: number, createdAt: number): PairingRequest {
	return {
		id: id(index),
		channel: "telegram",
		senderId: `requester-${index}`,
		code: `CODE${index}`,
		createdAt: new Date(createdAt),
		lastSeenAt: new Date(createdAt),
		agentId: AGENT_ID,
	};
}

function entry(index: number, createdAt: number): PairingAllowlistEntry {
	return {
		id: id(index),
		channel: "telegram",
		senderId: `allowed-${index}`,
		createdAt: new Date(createdAt),
		agentId: AGENT_ID,
	};
}

describe("InMemoryDatabaseAdapter pairing pagination", () => {
	it("keeps legacy ordering and returns deterministic bounded request pages", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await adapter.createPairingRequests([
			request(1, 1_000),
			request(3, 2_000),
			request(2, 2_000),
		]);

		const [legacy] = await adapter.getPairingRequests([
			{ channel: "telegram", agentId: AGENT_ID },
		]);
		expect(legacy.requests.map((item) => item.id)).toEqual([
			id(1),
			id(3),
			id(2),
		]);
		expect(legacy.pageInfo).toBeUndefined();

		const [firstPage] = await adapter.getPairingRequests([
			{
				channel: "telegram",
				agentId: AGENT_ID,
				createdAfter: new Date(1_500),
				order: "newest",
				limit: 1,
				offset: 0,
			},
		]);
		expect(firstPage.requests.map((item) => item.id)).toEqual([id(3)]);
		expect(firstPage.pageInfo).toEqual({
			limit: 1,
			offset: 0,
			hasMore: true,
			nextOffset: 1,
		});

		const [lastPage] = await adapter.getPairingRequests([
			{
				channel: "telegram",
				agentId: AGENT_ID,
				createdAfter: new Date(1_500),
				order: "newest",
				limit: 1,
				offset: 1,
			},
		]);
		expect(lastPage.requests.map((item) => item.id)).toEqual([id(2)]);
		expect(lastPage.pageInfo?.nextOffset).toBeNull();
	});

	it("bounds allowlist pages and rejects invalid direct adapter options", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await adapter.createPairingAllowlistEntries([
			entry(4, 1_000),
			entry(6, 2_000),
			entry(5, 2_000),
		]);

		const [legacy] = await adapter.getPairingAllowlists([
			{ channel: "telegram", agentId: AGENT_ID },
		]);
		expect(legacy.entries.map((item) => item.id)).toEqual([
			id(4),
			id(6),
			id(5),
		]);

		const [page] = await adapter.getPairingAllowlists([
			{
				channel: "telegram",
				agentId: AGENT_ID,
				order: "newest",
				limit: 2,
				offset: 1,
			},
		]);
		expect(page.entries.map((item) => item.id)).toEqual([id(5), id(4)]);
		expect(page.pageInfo).toEqual({
			limit: 2,
			offset: 1,
			hasMore: false,
			nextOffset: null,
		});

		await expect(
			adapter.getPairingAllowlists([
				{ channel: "telegram", agentId: AGENT_ID, limit: 101 },
			]),
		).rejects.toBeInstanceOf(RangeError);
	});
});
