/**
 * Verifies safe sorting in `InMemoryConnectorAccountStorage` when `createdAt`
 * holds a non-finite value (NaN or Infinity). Runs against the real in-memory
 * storage; no runtime, adapter, or network stubs are involved.
 */

import { describe, expect, it } from "vitest";
import {
	type ConnectorAccount,
	InMemoryConnectorAccountStorage,
} from "./account-manager";

function makeAccount(
	id: string,
	provider: string,
	createdAt: number,
): ConnectorAccount {
	return {
		id,
		provider,
		label: `label-${id}`,
		role: "OWNER",
		purpose: ["messaging"],
		accessGate: "open",
		status: "connected",
		createdAt,
		updatedAt: createdAt,
	} as ConnectorAccount;
}

describe("InMemoryConnectorAccountStorage safe sort", () => {
	it("sorts safely when createdAt contains NaN and Infinity (ascending, id tie-break)", async () => {
		const storage = new InMemoryConnectorAccountStorage();
		await storage.upsertAccount(makeAccount("a", "slack", Number.NaN));
		await storage.upsertAccount(makeAccount("b", "slack", 100));
		await storage.upsertAccount(
			makeAccount("c", "slack", Number.POSITIVE_INFINITY),
		);
		await storage.upsertAccount(makeAccount("d", "slack", 50));

		const accounts = await storage.listAccounts("slack");
		// NaN and Infinity fall back to 0, so a and c (both 0) come first sorted
		// by id, then d (50), then b (100).
		expect(accounts.map((account) => account.id)).toEqual(["a", "c", "d", "b"]);
	});

	it("produces a total order for a single non-finite entry", async () => {
		const storage = new InMemoryConnectorAccountStorage();
		await storage.upsertAccount(makeAccount("b", "slack", Number.NaN));
		await storage.upsertAccount(makeAccount("a", "slack", 1000));
		await storage.upsertAccount(
			makeAccount("c", "slack", Number.POSITIVE_INFINITY),
		);

		const accounts = await storage.listAccounts("slack");
		// Both non-finite values fall back to 0 and tie-break by id, so the valid
		// 1000 timestamp sorts last.
		expect(accounts.map((account) => account.id)).toEqual(["b", "c", "a"]);
	});

	it("old comparator would return NaN for NaN inputs", () => {
		const a = makeAccount("a", "slack", Number.NaN);
		const b = makeAccount("b", "slack", 100);
		const oldResult = a.createdAt - b.createdAt;
		expect(Number.isNaN(oldResult)).toBe(true);
	});

	it("handles provider tie-break before createdAt", async () => {
		const storage = new InMemoryConnectorAccountStorage();
		await storage.upsertAccount(makeAccount("a1", "discord", 100));
		await storage.upsertAccount(makeAccount("b1", "slack", 10));

		const accounts = await storage.listAccounts();
		// provider localeCompare: discord < slack, so discord first regardless of createdAt
		expect(accounts[0].provider).toBe("discord");
		expect(accounts[1].provider).toBe("slack");
	});
});
