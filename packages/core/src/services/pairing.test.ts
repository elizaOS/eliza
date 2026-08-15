/**
 * Public PairingService pagination contract tests. The legacy array APIs stay
 * source-compatible while bounded pages carry validated options into storage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime, MOCK_AGENT_ID } from "../testing/mock-runtime";
import type {
	IAgentRuntime,
	PairingAllowlistEntry,
	PairingRequest,
	UUID,
} from "../types";
import { normalizePairingPageOptions } from "../types";
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
