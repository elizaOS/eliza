import { describe, expect, it, vi } from "vitest";
import { migrateChannelPairingData } from "../services/pairing-migration";
import type { UUID } from "../types";
import { ServiceType } from "../types/service";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const EXISTING_REQUEST_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const EXISTING_ALLOWLIST_ID = "00000000-0000-0000-0000-000000000003" as UUID;

function createRuntime() {
	const pairingService = {
		isAllowed: vi.fn(async () => false),
		addToAllowlist: vi.fn(async () => ({
			id: "00000000-0000-0000-0000-000000000004" as UUID,
			channel: "discord",
			senderId: "allowed-user",
			createdAt: new Date(),
			agentId: AGENT_ID,
		})),
	};

	const runtime = {
		agentId: AGENT_ID,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
		getService: vi.fn((serviceType: ServiceType) =>
			serviceType === ServiceType.PAIRING ? pairingService : null,
		),
		getPairingRequests: vi.fn(async () => [
			{
				requests: [
					{
						id: EXISTING_REQUEST_ID,
						channel: "discord",
						senderId: "old-user",
						code: "OLD12345",
						createdAt: new Date("2026-06-01T12:00:00.000Z"),
						lastSeenAt: new Date("2026-06-01T12:05:00.000Z"),
						agentId: AGENT_ID,
					},
				],
			},
		]),
		getPairingAllowlists: vi.fn(async () => [
			{
				entries: [
					{
						id: EXISTING_ALLOWLIST_ID,
						channel: "discord",
						senderId: "old-allowed-user",
						createdAt: new Date("2026-06-01T12:00:00.000Z"),
						agentId: AGENT_ID,
					},
				],
			},
		]),
		deletePairingRequests: vi.fn(async () => {}),
		deletePairingAllowlistEntries: vi.fn(async () => {}),
		createPairingRequest: vi.fn(async () => EXISTING_REQUEST_ID),
	};

	return { runtime, pairingService };
}

describe("pairing migration", () => {
	it("clears existing channel data before importing when clearExisting is set", async () => {
		const { runtime, pairingService } = createRuntime();

		const result = await migrateChannelPairingData(
			runtime as never,
			"discord",
			{
				version: 1,
				requests: [
					{
						id: "new-user",
						code: "new12345",
						createdAt: "2026-06-02T12:00:00.000Z",
						lastSeenAt: "2026-06-02T12:05:00.000Z",
					},
				],
			},
			{ version: 1, allowFrom: ["allowed-user"] },
			{ clearExisting: true, skipExpired: false },
		);

		expect(result).toMatchObject({
			channel: "discord",
			requestsMigrated: 1,
			allowlistEntriesMigrated: 1,
			errors: [],
		});
		expect(runtime.deletePairingRequests).toHaveBeenCalledWith([
			EXISTING_REQUEST_ID,
		]);
		expect(runtime.deletePairingAllowlistEntries).toHaveBeenCalledWith([
			EXISTING_ALLOWLIST_ID,
		]);
		expect(runtime.createPairingRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: "discord",
				senderId: "new-user",
				code: "NEW12345",
				agentId: AGENT_ID,
			}),
		);
		expect(pairingService.addToAllowlist).toHaveBeenCalledWith(
			"discord",
			"allowed-user",
		);
		expect(
			runtime.deletePairingRequests.mock.invocationCallOrder[0],
		).toBeLessThan(runtime.createPairingRequest.mock.invocationCallOrder[0]);
	});

	it("does not delete existing channel data during dry-run clearExisting", async () => {
		const { runtime, pairingService } = createRuntime();

		const result = await migrateChannelPairingData(
			runtime as never,
			"discord",
			{
				version: 1,
				requests: [
					{
						id: "new-user",
						code: "new12345",
						createdAt: "2026-06-02T12:00:00.000Z",
						lastSeenAt: "2026-06-02T12:05:00.000Z",
					},
				],
			},
			{ version: 1, allowFrom: ["allowed-user"] },
			{ clearExisting: true, dryRun: true, skipExpired: false },
		);

		expect(result.requestsMigrated).toBe(1);
		expect(result.allowlistEntriesMigrated).toBe(1);
		expect(runtime.deletePairingRequests).not.toHaveBeenCalled();
		expect(runtime.deletePairingAllowlistEntries).not.toHaveBeenCalled();
		expect(runtime.createPairingRequest).not.toHaveBeenCalled();
		expect(pairingService.addToAllowlist).not.toHaveBeenCalled();
		expect(runtime.logger.info).toHaveBeenCalledWith(
			{ src: "pairing-migration", channel: "discord" },
			"Would clear existing pairing data before migration (dry run)",
		);
	});
});
