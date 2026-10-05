/**
 * In-memory connector accounts are oldest-first. A same-millisecond tie must
 * follow UUID order, including when one id is uppercase.
 */
import { describe, expect, it } from "vitest";
import { InMemoryConnectorAccountStorage } from "./account-manager";

const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPPER = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const SAME = 1_700_000_000_000;

describe("connector account list UUID ties", () => {
	it("lists the lower UUID first when two accounts share createdAt", async () => {
		const storage = new InMemoryConnectorAccountStorage();
		for (const id of [UPPER, LOWER]) {
			await storage.upsertAccount({
				id,
				provider: "telegram",
				role: "OWNER",
				purpose: [],
				accessGate: "open",
				status: "connected",
				createdAt: SAME,
				updatedAt: SAME,
			});
		}

		const accounts = await storage.listAccounts("telegram");
		expect(accounts.map((account) => account.id)).toEqual([LOWER, UPPER]);
	});
});
