/**
 * Proves the real in-memory adapter generates record identities only through
 * the platform CSPRNG and fails closed when that primitive is unavailable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memory, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const entityId = "10000000-0000-0000-0000-000000000001" as UUID;
const roomId = "20000000-0000-0000-0000-000000000001" as UUID;
const accountId = "30000000-0000-4000-8000-000000000001" as UUID;
const memoryId = "30000000-0000-4000-8000-000000000002" as UUID;
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"crypto",
);

function installCrypto(value: object): void {
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value,
	});
}

function message(): Memory {
	return {
		agentId,
		entityId,
		roomId,
		content: { text: "secure identity" },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalCryptoDescriptor) {
		Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "crypto");
	}
});

describe("InMemoryDatabaseAdapter secure record identities", () => {
	it("uses crypto.randomUUID for generated connector and memory IDs", async () => {
		const randomUUID = vi
			.fn<() => `${string}-${string}-${string}-${string}-${string}`>()
			.mockReturnValueOnce(accountId)
			.mockReturnValueOnce(memoryId);
		installCrypto({ randomUUID });
		const weakRandom = vi.spyOn(Math, "random");
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();

		const account = await adapter.upsertConnectorAccount({
			agentId,
			provider: "github",
			accountKey: "secure-account",
			displayName: "Secure Account",
		});
		const [createdMemoryId] = await adapter.createMemories([
			{ memory: message(), tableName: "messages" },
		]);

		expect(account.id).toBe(accountId);
		expect(createdMemoryId).toBe(memoryId);
		expect(randomUUID).toHaveBeenCalledTimes(2);
		expect(weakRandom).not.toHaveBeenCalled();
	});

	it("fails closed instead of downgrading when the CSPRNG is unavailable", async () => {
		installCrypto({});
		const weakRandom = vi.spyOn(Math, "random");
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();

		await expect(
			adapter.upsertConnectorAccount({
				agentId,
				provider: "github",
				accountKey: "no-csprng",
				displayName: "No CSPRNG",
			}),
		).rejects.toMatchObject({ code: "IN_MEMORY_ADAPTER_CSPRNG_UNAVAILABLE" });
		await expect(
			adapter.createMemories([{ memory: message(), tableName: "messages" }]),
		).rejects.toMatchObject({ code: "IN_MEMORY_ADAPTER_CSPRNG_UNAVAILABLE" });
		expect(weakRandom).not.toHaveBeenCalled();
	});
});
