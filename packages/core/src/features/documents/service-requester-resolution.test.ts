/**
 * Pins DocumentService's exported requester-resolution surface: role lookup for
 * runtime/self/human senders through the real checkSenderRole chain, room
 * enumeration with dedupe, the typed DOCUMENT_ROLE_LOOKUP_FAILED and
 * DOCUMENT_ROOM_LOOKUP_FAILED wraps, and the provider resolver's promise memo
 * with rejection eviction. Role and membership cases run against a real
 * AgentRuntime + InMemoryDatabaseAdapter; error-wrap and memoization cases use
 * minimal storage-boundary stubs because they assert this module's own wrapping
 * and caching behavior.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { ElizaError } from "../../errors";
import { AgentRuntime } from "../../runtime";
import type {
	AccessContext,
	Character,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../types";
import { ChannelType } from "../../types";
import {
	createDocumentProviderRequesterResolver,
	resolveDocumentRequester,
	resolveDocumentRequesterFromAccessContext,
	resolveDocumentRequesterRole,
} from "./service.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000e1a7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000d1e5" as UUID;
const GUEST_ID = "00000000-0000-0000-0000-00000000a17e" as UUID;
const ROOM_A = "00000000-0000-0000-0000-00000000b100" as UUID;
const ROOM_B = "00000000-0000-0000-0000-00000000b200" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const MISSING_ROOM = "00000000-0000-0000-0000-00000000deaf" as UUID;

async function makeHarness(): Promise<{
	runtime: AgentRuntime;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: {
			name: "DocumentRequesterResolutionAgent",
			bio: "Exercises document requester resolution semantics.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: AGENT_ID,
			name: "requester-resolution world",
			metadata: { roles: { [USER_ID]: "USER" } },
		},
	]);
	await adapter.createRooms([
		{
			id: ROOM_A,
			agentId: AGENT_ID,
			source: "test",
			type: ChannelType.GROUP,
			worldId: WORLD_ID,
		},
		{
			id: ROOM_B,
			agentId: AGENT_ID,
			source: "test",
			type: ChannelType.GROUP,
			worldId: WORLD_ID,
		},
	]);
	await adapter.createRoomParticipants([AGENT_ID, USER_ID], ROOM_A);
	await adapter.createRoomParticipants([AGENT_ID, USER_ID, GUEST_ID], ROOM_B);
	return { runtime };
}

function messageFrom(
	entityId: UUID | undefined,
	roomId: UUID = ROOM_A,
): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000face" as UUID,
		agentId: AGENT_ID,
		entityId,
		roomId,
		content: { text: "resolve my document access" },
	} as Memory;
}

describe("DocumentService requester resolution", () => {
	describe("resolveDocumentRequesterRole", () => {
		it("returns RUNTIME for a missing message", async () => {
			const { runtime } = await makeHarness();
			await expect(resolveDocumentRequesterRole(runtime)).resolves.toEqual({
				entityId: AGENT_ID,
				role: "RUNTIME",
			});
		});

		it("returns RUNTIME when the message carries no entityId", async () => {
			const { runtime } = await makeHarness();
			await expect(
				resolveDocumentRequesterRole(runtime, messageFrom(undefined)),
			).resolves.toEqual({ entityId: AGENT_ID, role: "RUNTIME" });
		});

		it("resolves self-authored messages to AGENT without touching storage", async () => {
			const { runtime } = await makeHarness();
			const getRoomSpy = vi.spyOn(runtime, "getRoom");
			const getRoomsSpy = vi.spyOn(runtime, "getRoomsForParticipants");
			await expect(
				resolveDocumentRequesterRole(runtime, messageFrom(AGENT_ID)),
			).resolves.toEqual({ entityId: AGENT_ID, role: "AGENT" });
			expect(getRoomSpy).not.toHaveBeenCalled();
			expect(getRoomsSpy).not.toHaveBeenCalled();
		});

		it("reads a human sender's world role through the real role chain", async () => {
			const { runtime } = await makeHarness();
			await expect(
				resolveDocumentRequesterRole(runtime, messageFrom(USER_ID)),
			).resolves.toEqual({ entityId: USER_ID, role: "USER" });
		});

		it("falls back to GUEST for a participant without a stored world role", async () => {
			const { runtime } = await makeHarness();
			await expect(
				resolveDocumentRequesterRole(runtime, messageFrom(GUEST_ID)),
			).resolves.toEqual({ entityId: GUEST_ID, role: "GUEST" });
		});

		it("reports UNRESOLVED when the message's room cannot be found", async () => {
			const { runtime } = await makeHarness();
			await expect(
				resolveDocumentRequesterRole(
					runtime,
					messageFrom(USER_ID, MISSING_ROOM),
				),
			).resolves.toEqual({ entityId: USER_ID, role: "UNRESOLVED" });
		});

		it("wraps role-lookup failures in DOCUMENT_ROLE_LOOKUP_FAILED and reports them", async () => {
			const cause = new Error("room store unavailable");
			const reportError = vi.fn();
			const failingRuntime = {
				agentId: AGENT_ID,
				getRoom: async () => {
					throw cause;
				},
				reportError,
			} as unknown as IAgentRuntime;

			const outcome = resolveDocumentRequesterRole(
				failingRuntime,
				messageFrom(USER_ID),
			);
			await expect(outcome).rejects.toBeInstanceOf(ElizaError);
			await expect(outcome).rejects.toMatchObject({
				code: "DOCUMENT_ROLE_LOOKUP_FAILED",
				cause,
			});
			expect(reportError).toHaveBeenCalledTimes(1);
			expect(reportError.mock.calls[0][0]).toBe(
				"DocumentService.resolveRequesterRole",
			);
		});
	});

	describe("resolveDocumentRequesterFromAccessContext", () => {
		it("skips room enumeration for globally-visible roles", async () => {
			const { runtime } = await makeHarness();
			const getRoomsSpy = vi.spyOn(runtime, "getRoomsForParticipants");
			const context: AccessContext = {
				requesterEntityId: USER_ID,
				role: "OWNER",
			};
			await expect(
				resolveDocumentRequesterFromAccessContext(runtime, context),
			).resolves.toEqual({ entityId: USER_ID, roomIds: [], role: "OWNER" });
			expect(getRoomsSpy).not.toHaveBeenCalled();
		});

		it("resolves room membership and stays UNRESOLVED when the context omits a role", async () => {
			const { runtime } = await makeHarness();
			const context: AccessContext = { requesterEntityId: USER_ID };
			const requester = await resolveDocumentRequesterFromAccessContext(
				runtime,
				context,
			);
			expect(requester.entityId).toBe(USER_ID);
			expect(requester.role).toBe("UNRESOLVED");
			expect([...requester.roomIds].sort()).toEqual([ROOM_A, ROOM_B].sort());
		});

		it("dedupes repeated rooms returned by the room store", async () => {
			const { runtime } = await makeHarness();
			const realGetRooms = runtime.getRoomsForParticipants.bind(runtime);
			vi.spyOn(runtime, "getRoomsForParticipants").mockImplementation(
				async (entityIds) => [...(await realGetRooms(entityIds)), ROOM_A],
			);
			const requester = await resolveDocumentRequesterFromAccessContext(
				runtime,
				{ requesterEntityId: USER_ID, role: "USER" },
			);
			expect(requester.roomIds).toEqual([ROOM_A, ROOM_B]);
		});

		it("wraps room-lookup failures in DOCUMENT_ROOM_LOOKUP_FAILED preserving the cause", async () => {
			const cause = new Error("participant index offline");
			const failingRuntime = {
				agentId: AGENT_ID,
				getRoomsForParticipants: async () => {
					throw cause;
				},
			} as unknown as IAgentRuntime;

			const outcome = resolveDocumentRequesterFromAccessContext(
				failingRuntime,
				{
					requesterEntityId: USER_ID,
					role: "USER",
				},
			);
			await expect(outcome).rejects.toBeInstanceOf(ElizaError);
			await expect(outcome).rejects.toMatchObject({
				code: "DOCUMENT_ROOM_LOOKUP_FAILED",
				cause,
			});
		});
	});

	describe("resolveDocumentRequester", () => {
		it("short-circuits self-authored messages to empty rooms", async () => {
			const { runtime } = await makeHarness();
			await expect(
				resolveDocumentRequester(runtime, messageFrom(AGENT_ID)),
			).resolves.toEqual({
				entityId: AGENT_ID,
				role: "AGENT",
				roomIds: [],
			});
		});

		it("attaches deduplicated room membership to a human sender", async () => {
			const { runtime } = await makeHarness();
			const requester = await resolveDocumentRequester(
				runtime,
				messageFrom(USER_ID),
			);
			expect(requester.entityId).toBe(USER_ID);
			expect(requester.role).toBe("USER");
			expect([...new Set(requester.roomIds)]).toEqual(requester.roomIds);
			expect([...requester.roomIds].sort()).toEqual([ROOM_A, ROOM_B].sort());
		});

		it("reports and wraps room-lookup failures after an unresolved role", async () => {
			const cause = new Error("room enumeration failed");
			const reportError = vi.fn();
			const failingRuntime = {
				agentId: AGENT_ID,
				getRoom: async () => null,
				reportError,
				getRoomsForParticipants: async () => {
					throw cause;
				},
			} as unknown as IAgentRuntime;

			const outcome = resolveDocumentRequester(
				failingRuntime,
				messageFrom(USER_ID),
			);
			await expect(outcome).rejects.toBeInstanceOf(ElizaError);
			await expect(outcome).rejects.toMatchObject({
				code: "DOCUMENT_ROOM_LOOKUP_FAILED",
				cause,
			});
			expect(reportError).toHaveBeenCalledTimes(1);
			expect(reportError.mock.calls[0][0]).toBe(
				"DocumentService.resolveRequesterRooms",
			);
		});
	});

	describe("createDocumentProviderRequesterResolver", () => {
		function stubRuntime(roomsByCall: UUID[][]): {
			runtime: IAgentRuntime;
			getRoomsForParticipants: ReturnType<typeof vi.fn>;
		} {
			const getRoomsForParticipants = vi.fn(
				(): Promise<UUID[]> =>
					Promise.resolve(
						roomsByCall[
							Math.min(
								getRoomsForParticipants.mock.calls.length,
								roomsByCall.length - 1,
							)
						],
					),
			);
			return {
				runtime: {
					agentId: AGENT_ID,
					getRoom: async () => null,
					getRoomsForParticipants,
				} as unknown as IAgentRuntime,
				getRoomsForParticipants,
			};
		}

		it("shares one in-flight resolution between concurrent callers", async () => {
			const { runtime, getRoomsForParticipants } = stubRuntime([[ROOM_A]]);
			const resolver = createDocumentProviderRequesterResolver(
				runtime,
				messageFrom(USER_ID),
			);
			const first = resolver();
			const second = resolver();
			expect(second).toBe(first);
			await expect(first).resolves.toMatchObject({
				entityId: USER_ID,
				roomIds: [ROOM_A],
			});
			expect(getRoomsForParticipants).toHaveBeenCalledTimes(1);
		});

		it("keeps reusing the settled memo on subsequent turns of one composition", async () => {
			const { runtime, getRoomsForParticipants } = stubRuntime([[ROOM_A]]);
			const resolver = createDocumentProviderRequesterResolver(
				runtime,
				messageFrom(USER_ID),
			);
			const first = await resolver();
			const second = await resolver();
			expect(second).toEqual(first);
			expect(getRoomsForParticipants).toHaveBeenCalledTimes(1);
		});

		it("evicts a rejected memo so the next read re-resolves authority", async () => {
			const failingThenWorking = vi
				.fn()
				.mockImplementationOnce(async () => {
					throw new Error("transient authorization outage");
				})
				.mockImplementation(async () => [ROOM_A]);
			const runtime = {
				agentId: AGENT_ID,
				getRoom: async () => null,
				reportError: vi.fn(),
				getRoomsForParticipants: failingThenWorking,
			} as unknown as IAgentRuntime;
			const resolver = createDocumentProviderRequesterResolver(
				runtime,
				messageFrom(USER_ID),
			);

			const firstAttempt = resolver();
			await expect(firstAttempt).rejects.toBeInstanceOf(ElizaError);

			const secondAttempt = resolver();
			expect(secondAttempt).not.toBe(firstAttempt);
			await expect(secondAttempt).resolves.toMatchObject({
				entityId: USER_ID,
				role: "UNRESOLVED",
				roomIds: [ROOM_A],
			});
			expect(failingThenWorking).toHaveBeenCalledTimes(2);
		});
	});
});
