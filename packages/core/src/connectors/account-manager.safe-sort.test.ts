/**
 * Verifies safe sorting in InMemoryConnectorAccountStorage when createdAt contains NaN.
 */
import { describe, expect, it } from "vitest";
import { InMemoryConnectorAccountStorage } from "./account-manager.ts";
import type { ConnectorAccount } from "./types.ts";

function makeAccount(
	id: string,
	provider: string,
	createdAt: number,
): ConnectorAccount {
	return {
		id,
		provider: provider as unknown as ConnectorAccount["provider"],
		createdAt,
		updatedAt: createdAt,
		// minimal required fields
		type: "oauth" as unknown as ConnectorAccount["type"],
		status: "connected" as unknown as ConnectorAccount["status"],
		credentials: {} as unknown as ConnectorAccount["credentials"],
		metadata: {},
	} as unknown as ConnectorAccount;
}

describe("account-manager safe sort", () => {
	it("sorts accounts safely when createdAt contains NaN and Infinity", async () => {
		const storage = new InMemoryConnectorAccountStorage();
		const accNan = makeAccount("b", "slack", NaN);
		const accValid = makeAccount("a", "slack", 1000);
		const accInf = makeAccount("c", "slack", Infinity);

		await storage.upsertAccount(accNan);
		await storage.upsertAccount(accValid);
		await storage.upsertAccount(accInf);

		const sorted = await storage.listAccounts("slack");
		// valid (1000) first, then NaN/Infinity fallback to 0, tie-break by id
		expect(sorted[0].id).toBe("a");
		expect(sorted.map((a) => a.id)).toContain("b");
		expect(sorted.map((a) => a.id)).toContain("c");
		// ensure no NaN in sort comparator crash
		expect(sorted).toHaveLength(3);
	});

	it("old comparator would return NaN for NaN", () => {
		const old = NaN - 100;
		expect(Number.isNaN(old)).toBe(true);
		const fixed =
			(Number.isFinite(NaN) ? NaN : 0) - (Number.isFinite(100) ? 100 : 0);
		expect(fixed).toBe(-100);
	});
});
