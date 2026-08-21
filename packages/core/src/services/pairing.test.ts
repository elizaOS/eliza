/**
 * Public PairingService contract tests: bounded pagination reads (the legacy
 * array APIs stay source-compatible while bounded pages carry validated
 * options into storage), the pairing-code entropy source (CSPRNG-only,
 * fail-closed when no CSPRNG exists), the pending-queue cap (reject-at-max,
 * never evict), and the per-sender pairing-reply claim window. The storage
 * adapter is mocked; the service under test is real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime, MOCK_AGENT_ID } from "../testing/mock-runtime";
import type {
	IAgentRuntime,
	PairingAllowlistEntry,
	PairingRequest,
	UUID,
} from "../types";
import { normalizePairingPageOptions, PAIRING_CODE_ALPHABET } from "../types";
import { PairingService } from "./pairing";

function uuid(index: number): UUID {
	return `00000000-0000-0000-0000-${index.toString().padStart(12, "0")}` as UUID;
}

function request(index: number, createdAt: Date): PairingRequest {
	return {
		id: uuid(index),
		channel: "discord",
		senderId: `sender-${index}`,
		code: `CODE${index}`,
		createdAt,
		lastSeenAt: createdAt,
		agentId: MOCK_AGENT_ID,
	};
}

function allowlistEntry(index: number): PairingAllowlistEntry {
	return {
		id: uuid(index),
		channel: "discord",
		senderId: `sender-${index}`,
		createdAt: new Date(index * 1_000),
		agentId: MOCK_AGENT_ID,
	};
}

function runtimeWith(
	overrides: Pick<IAgentRuntime, "getPairingRequests" | "getPairingAllowlists">,
): IAgentRuntime {
	return createMockRuntime({
		...overrides,
		deletePairingRequest: vi.fn(async () => undefined),
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("PairingService bounded reads", () => {
	it("preserves the legacy pending-request array API", async () => {
		const getPairingRequests = vi.fn<IAgentRuntime["getPairingRequests"]>(
			async () => [
				{
					channel: "discord",
					agentId: MOCK_AGENT_ID,
					requests: [
						request(2, new Date("2026-01-02T00:00:00.000Z")),
						request(1, new Date("2026-01-01T00:00:00.000Z")),
					],
				},
			],
		);
		const runtime = runtimeWith({
			getPairingRequests,
			getPairingAllowlists: vi.fn(async () => []),
		});

		const result = await new PairingService(runtime, {
			requestTtlMs: Number.MAX_SAFE_INTEGER,
		}).listPendingRequests("discord");

		expect(result.map((item) => item.id)).toEqual([uuid(1), uuid(2)]);
		expect(getPairingRequests).toHaveBeenCalledWith([
			{ channel: "discord", agentId: MOCK_AGENT_ID },
		]);
	});

	it("returns a typed newest-first pending page and pushes TTL bounds into storage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const sameTime = new Date("2026-01-09T23:59:30.000Z");
		const getPairingRequests = vi.fn<IAgentRuntime["getPairingRequests"]>(
			async () => [
				{
					channel: "discord",
					agentId: MOCK_AGENT_ID,
					requests: [request(1, sameTime), request(2, sameTime)],
					pageInfo: {
						limit: 2,
						offset: 4,
						hasMore: true,
						nextOffset: 6,
					},
				},
			],
		);
		const runtime = runtimeWith({
			getPairingRequests,
			getPairingAllowlists: vi.fn(async () => []),
		});
		const service = new PairingService(runtime, { requestTtlMs: 60_000 });

		await expect(
			service.listPendingRequestsPage("discord", { limit: 2, offset: 4 }),
		).resolves.toEqual({
			items: [request(2, sameTime), request(1, sameTime)],
			limit: 2,
			offset: 4,
			hasMore: true,
			nextOffset: 6,
		});
		expect(getPairingRequests).toHaveBeenCalledWith([
			{
				channel: "discord",
				agentId: MOCK_AGENT_ID,
				limit: 2,
				offset: 4,
				order: "newest",
				createdAfter: new Date("2026-01-09T23:59:00.000Z"),
			},
		]);
	});

	it("uses one TTL cutoff for storage and post-filtering", async () => {
		vi.useFakeTimers();
		const now = new Date("2026-01-10T00:00:00.000Z");
		vi.setSystemTime(now);
		const createdAt = new Date(now.getTime() - 500);
		const requestNearExpiry = request(7, createdAt);
		const getPairingRequests = vi.fn<IAgentRuntime["getPairingRequests"]>(
			async () => {
				// Simulate the clock crossing the TTL boundary while the adapter reads.
				vi.setSystemTime(new Date(now.getTime() + 501));
				return [
					{
						channel: "discord",
						agentId: MOCK_AGENT_ID,
						requests: [requestNearExpiry],
						pageInfo: {
							limit: 1,
							offset: 0,
							hasMore: false,
							nextOffset: null,
						},
					},
				];
			},
		);
		const runtime = runtimeWith({
			getPairingRequests,
			getPairingAllowlists: vi.fn(async () => []),
		});

		await expect(
			new PairingService(runtime, {
				requestTtlMs: 1_000,
			}).listPendingRequestsPage("discord", { limit: 1 }),
		).resolves.toMatchObject({ items: [requestNearExpiry] });
		expect(getPairingRequests).toHaveBeenCalledWith([
			expect.objectContaining({
				createdAfter: new Date(now.getTime() - 1_000),
			}),
		]);
	});

	it("bounds legacy third-party adapter results when page metadata is absent", async () => {
		const getPairingAllowlists = vi.fn<IAgentRuntime["getPairingAllowlists"]>(
			async () => [
				{
					channel: "discord",
					agentId: MOCK_AGENT_ID,
					entries: [1, 4, 2, 3].map(allowlistEntry),
				},
			],
		);
		const runtime = runtimeWith({
			getPairingRequests: vi.fn(async () => []),
			getPairingAllowlists,
		});

		await expect(
			new PairingService(runtime).getAllowlistPage("discord", {
				limit: 2,
				offset: 1,
			}),
		).resolves.toEqual({
			items: [allowlistEntry(3), allowlistEntry(2)],
			limit: 2,
			offset: 1,
			hasMore: true,
			nextOffset: 3,
		});
	});

	it("returns an empty final page with the default bounds", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const getPairingRequests = vi.fn<IAgentRuntime["getPairingRequests"]>(
			async () => [
				{
					channel: "discord",
					agentId: MOCK_AGENT_ID,
					requests: [],
					pageInfo: {
						limit: 50,
						offset: 0,
						hasMore: false,
						nextOffset: null,
					},
				},
			],
		);
		const runtime = runtimeWith({
			getPairingRequests,
			getPairingAllowlists: vi.fn(async () => []),
		});

		await expect(
			new PairingService(runtime).listPendingRequestsPage("discord"),
		).resolves.toEqual({
			items: [],
			limit: 50,
			offset: 0,
			hasMore: false,
			nextOffset: null,
		});
		expect(getPairingRequests).toHaveBeenCalledWith([
			expect.objectContaining({ limit: 50, offset: 0, order: "newest" }),
		]);
	});

	it.each([
		{ limit: 0 },
		{ limit: 101 },
		{ limit: 1.5 },
		{ offset: -1 },
		{ offset: 1.5 },
		{ offset: Number.MAX_SAFE_INTEGER + 1 },
		{ offset: Number.MAX_VALUE },
	])(
		"rejects invalid page options before reading storage: %j",
		async (options) => {
			const getPairingRequests = vi.fn<IAgentRuntime["getPairingRequests"]>(
				async () => [],
			);
			const runtime = runtimeWith({
				getPairingRequests,
				getPairingAllowlists: vi.fn(async () => []),
			});

			await expect(
				new PairingService(runtime).listPendingRequestsPage("discord", options),
			).rejects.toBeInstanceOf(RangeError);
			expect(getPairingRequests).not.toHaveBeenCalled();
		},
	);

	it("accepts the maximum safe offset and rejects unsafe integers", () => {
		expect(
			normalizePairingPageOptions({ offset: Number.MAX_SAFE_INTEGER }),
		).toEqual({
			limit: 50,
			offset: Number.MAX_SAFE_INTEGER,
		});
		expect(() =>
			normalizePairingPageOptions({ offset: Number.MAX_SAFE_INTEGER + 1 }),
		).toThrow(RangeError);
	});
});

describe("PairingService pairing-code entropy", () => {
	const noop = () => undefined;

	function upsertRuntime(): IAgentRuntime {
		return createMockRuntime({
			getPairingRequests: vi.fn(async () => [
				{ channel: "discord", agentId: MOCK_AGENT_ID, requests: [] },
			]),
			createPairingRequest: vi.fn(async () => undefined),
			updatePairingRequest: vi.fn(async () => undefined),
			deletePairingRequest: vi.fn(async () => undefined),
			logger: {
				debug: noop,
				info: noop,
				warn: noop,
				error: noop,
			} as unknown as IAgentRuntime["logger"],
		});
	}

	it("draws codes from the platform CSPRNG, never Math.random", async () => {
		const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues");
		const mathRandom = vi.spyOn(Math, "random");
		try {
			const result = await new PairingService(upsertRuntime()).upsertRequest({
				channel: "discord",
				senderId: "sender-entropy",
			});

			expect(result.created).toBe(true);
			expect(result.code).toHaveLength(8);
			for (const char of result.code) {
				expect(PAIRING_CODE_ALPHABET).toContain(char);
			}
			expect(getRandomValues).toHaveBeenCalled();
			expect(mathRandom).not.toHaveBeenCalled();
		} finally {
			getRandomValues.mockRestore();
			mathRandom.mockRestore();
		}
	});

	it("fails closed when the platform has no CSPRNG", async () => {
		vi.stubGlobal("crypto", undefined);
		try {
			await expect(
				new PairingService(upsertRuntime()).upsertRequest({
					channel: "discord",
					senderId: "sender-no-csprng",
				}),
			).rejects.toMatchObject({ code: "PAIRING_CSPRNG_UNAVAILABLE" });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("PairingService pending-queue cap", () => {
	const noop = () => undefined;

	function cappedQueueRuntime(pending: PairingRequest[]) {
		const deletePairingRequest = vi.fn(async () => undefined);
		const createPairingRequest = vi.fn(async () => undefined);
		const updatePairingRequest = vi.fn(async () => undefined);
		const runtime = createMockRuntime({
			getPairingRequests: vi.fn(async () => [
				{ channel: "discord", agentId: MOCK_AGENT_ID, requests: pending },
			]),
			createPairingRequest,
			updatePairingRequest,
			deletePairingRequest,
			logger: {
				debug: noop,
				info: noop,
				warn: noop,
				error: noop,
			} as unknown as IAgentRuntime["logger"],
		});
		return {
			runtime,
			deletePairingRequest,
			createPairingRequest,
			updatePairingRequest,
		};
	}

	it("rejects a new sender at the cap instead of evicting the oldest pending request", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const pending = [
			request(1, new Date("2026-01-10T00:00:00.000Z")),
			request(2, new Date("2026-01-10T00:00:01.000Z")),
			request(3, new Date("2026-01-10T00:00:02.000Z")),
		];
		const { runtime, deletePairingRequest, createPairingRequest } =
			cappedQueueRuntime(pending);

		const result = await new PairingService(runtime, {
			maxPendingRequests: 3,
			requestTtlMs: Number.MAX_SAFE_INTEGER,
		}).upsertRequest({ channel: "discord", senderId: "sender-new" });

		expect(result).toEqual({ code: "", created: false, request: undefined });
		expect(createPairingRequest).not.toHaveBeenCalled();
		// The legitimate pending requests must survive a flood of new identities.
		expect(deletePairingRequest).not.toHaveBeenCalled();
	});

	it("still refreshes an existing sender's request when the queue is full", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const existing = request(1, new Date("2026-01-10T00:00:00.000Z"));
		const pending = [
			existing,
			request(2, new Date("2026-01-10T00:00:01.000Z")),
			request(3, new Date("2026-01-10T00:00:02.000Z")),
		];
		const { runtime, updatePairingRequest } = cappedQueueRuntime(pending);

		const result = await new PairingService(runtime, {
			maxPendingRequests: 3,
			requestTtlMs: Number.MAX_SAFE_INTEGER,
		}).upsertRequest({ channel: "discord", senderId: existing.senderId });

		expect(result.created).toBe(false);
		expect(result.code).toBe(existing.code);
		expect(result.request?.senderId).toBe(existing.senderId);
		expect(updatePairingRequest).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent admissions so the pending queue cannot overrun its cap", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const pending: PairingRequest[] = [];
		const { runtime, createPairingRequest } = cappedQueueRuntime(pending);
		createPairingRequest.mockImplementation(async (created: PairingRequest) => {
			// Yield once to make an unguarded read-check-create race deterministic.
			await Promise.resolve();
			pending.push(created);
		});
		const service = new PairingService(runtime, {
			maxPendingRequests: 3,
			requestTtlMs: Number.MAX_SAFE_INTEGER,
		});

		const results = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				service.upsertRequest({
					channel: "discord",
					senderId: `concurrent-sender-${index}`,
				}),
			),
		);

		expect(results.filter((result) => result.created)).toHaveLength(3);
		expect(results.filter((result) => !result.code)).toHaveLength(9);
		expect(pending).toHaveLength(3);
		expect(createPairingRequest).toHaveBeenCalledTimes(3);
	});
});

describe("PairingService pairing reply claims", () => {
	function claimRuntime(): IAgentRuntime {
		return createMockRuntime({
			getPairingRequests: vi.fn(async () => [
				{ channel: "discord", agentId: MOCK_AGENT_ID, requests: [] },
			]),
		});
	}

	it("claims at most one reply per sender per request TTL", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const service = new PairingService(claimRuntime(), {
			requestTtlMs: 60_000,
		});

		expect(service.claimPairingReply("discord", "sender-1")).toBe(true);
		expect(service.claimPairingReply("discord", "sender-1")).toBe(false);
		// Other senders and other channels are independent claims.
		expect(service.claimPairingReply("discord", "sender-2")).toBe(true);
		expect(service.claimPairingReply("telegram", "sender-1")).toBe(true);

		vi.setSystemTime(new Date("2026-01-10T00:01:01.000Z"));
		expect(service.claimPairingReply("discord", "sender-1")).toBe(true);
	});
});
