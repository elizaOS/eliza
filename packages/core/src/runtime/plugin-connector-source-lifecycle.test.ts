/**
 * Checks that a plugin's `connectorSources` declarations register their aliases
 * and passive flag on plugin load and are fully removed on unload. Drives a real
 * in-process `AgentRuntime`; membership capability checks use the real in-memory
 * adapter and never call a model.
 */
import { describe, expect, it } from "vitest";
import {
	getConnectorSourceAliases,
	isPassiveConnectorSource,
	normalizeConnectorSource,
} from "../connectors";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { RoomMembershipEvidencePublisher } from "../types/database";
import type { Plugin } from "../types/plugin";
import { ChannelType, type UUID } from "../types/primitives";

const AGENT_ID = "00000000-0000-4000-8000-000000000101" as UUID;
const ENTITY_ID = "00000000-0000-4000-8000-000000000102" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000103" as UUID;

async function createMembershipRuntime(
	roomSource = "owned-source-account",
	connectorAccountId = "account-a",
): Promise<AgentRuntime> {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		adapter,
		logLevel: "fatal",
	});
	await adapter.createEntities([
		{ id: ENTITY_ID, agentId: AGENT_ID, names: ["Member"] },
	]);
	await adapter.createRooms([
		{
			id: ROOM_ID,
			agentId: AGENT_ID,
			source: roomSource,
			type: ChannelType.GROUP,
			metadata: { connectorAccountId },
		},
	]);
	await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
	return runtime;
}

describe("plugin connector source lifecycle", () => {
	it("registers and unloads plugin-owned connector source declarations", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const plugin: Plugin = {
			name: "connector-source-owner",
			description: "Declares connector source aliases",
			connectorSources: [
				{
					source: "owned-source",
					aliases: ["owned-source", "owned-source-account"],
					sourceKind: "passive",
					isPassive: true,
				},
			],
		};

		expect(normalizeConnectorSource("owned-source-account")).toBe(
			"owned-source-account",
		);

		await runtime.registerPlugin(plugin);

		expect(normalizeConnectorSource("owned-source-account")).toBe(
			"owned-source",
		);
		expect(getConnectorSourceAliases("owned-source")).toEqual([
			"owned-source",
			"owned-source-account",
		]);
		expect(isPassiveConnectorSource("owned-source-account")).toBe(true);

		await runtime.unloadPlugin("connector-source-owner");

		expect(normalizeConnectorSource("owned-source-account")).toBe(
			"owned-source-account",
		);
		expect(isPassiveConnectorSource("owned-source-account")).toBe(false);
	});

	it("derives transport provenance and revokes the publisher on unload", async () => {
		const runtime = await createMembershipRuntime();
		let publisher: RoomMembershipEvidencePublisher | undefined;
		const plugin: Plugin = {
			name: "membership-source-owner",
			description: "Owns membership observations for one direct transport",
			connectorSources: [
				{
					source: "owned-source",
					aliases: ["owned-source-account"],
					sourceKind: "passive",
					isPassive: true,
				},
			],
			init: (_config, pluginRuntime) => {
				publisher = pluginRuntime.registerRoomMembershipEvidencePublisher(
					"owned-source-account",
					"account-a",
				);
			},
		};

		await runtime.registerPlugin(plugin);
		expect(publisher?.source).toBe("owned-source");
		expect(publisher?.accountId).toBe("account-a");
		const observedAt = Date.now();
		await expect(
			publisher?.publish({
				evidence: {
					entityId: ENTITY_ID,
					roomId: ROOM_ID,
					state: "member",
					observedAt,
					expiresAt: observedAt + 60_000,
					generation: 1,
				},
				expectedGeneration: null,
			}),
		).resolves.toMatchObject({
			status: "updated",
			evidence: {
				source: expect.stringMatching(
					/^transport:owned-source\.[0-9a-f-]{36}$/,
				),
			},
		});
		await runtime.unloadPlugin(plugin.name);
		await expect(
			publisher?.publish({
				evidence: {
					entityId: ENTITY_ID,
					roomId: ROOM_ID,
					state: "nonmember",
					observedAt: observedAt + 1,
					generation: 2,
				},
				expectedGeneration: 1,
			}),
		).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_PUBLISHER_REVOKED" });
	});

	it("rejects publisher registration outside an owning direct plugin init", async () => {
		const runtime = await createMembershipRuntime();
		expect(() =>
			runtime.registerRoomMembershipEvidencePublisher(
				"owned-source",
				"account-a",
			),
		).toThrow(/only be registered during plugin init/);

		await expect(
			runtime.registerPlugin({
				name: "undeclared-membership-source",
				description: "Does not own the requested source",
				init: (_config, pluginRuntime) => {
					pluginRuntime.registerRoomMembershipEvidencePublisher(
						"owned-source",
						"account-a",
					);
				},
			}),
		).rejects.toMatchObject({
			code: "ROOM_MEMBERSHIP_PUBLISHER_SOURCE_FORBIDDEN",
		});

		await expect(
			runtime.registerPlugin({
				name: "remote-membership-source",
				description: "Remote plugins cannot mint membership",
				mode: "remote",
				connectorSources: [{ source: "owned-source" }],
				init: (_config, pluginRuntime) => {
					pluginRuntime.registerRoomMembershipEvidencePublisher(
						"owned-source",
						"account-a",
					);
				},
			}),
		).rejects.toMatchObject({
			code: "ROOM_MEMBERSHIP_PUBLISHER_REGISTRATION_FORBIDDEN",
		});
	});

	it("rejects observations outside the publisher's room and entity authority", async () => {
		const runtime = await createMembershipRuntime("different-source");
		let publisher: RoomMembershipEvidencePublisher | undefined;
		await runtime.registerPlugin({
			name: "bounded-membership-source",
			description: "Owns only the declared transport source",
			connectorSources: [{ source: "owned-source" }],
			init: (_config, pluginRuntime) => {
				publisher = pluginRuntime.registerRoomMembershipEvidencePublisher(
					"owned-source",
					"account-a",
				);
			},
		});
		const observedAt = Date.now();
		await expect(
			publisher?.publish({
				evidence: {
					entityId: ENTITY_ID,
					roomId: ROOM_ID,
					state: "member",
					observedAt,
					expiresAt: observedAt + 60_000,
					generation: 1,
				},
				expectedGeneration: null,
			}),
		).rejects.toMatchObject({
			code: "ROOM_MEMBERSHIP_PUBLISHER_ROOM_FORBIDDEN",
		});
	});

	it("binds a publisher to the room's persisted connector account", async () => {
		const runtime = await createMembershipRuntime("owned-source", "account-b");
		let publisher: RoomMembershipEvidencePublisher | undefined;
		await runtime.registerPlugin({
			name: "account-bounded-membership-source",
			description: "Owns one connector account",
			connectorSources: [{ source: "owned-source" }],
			init: (_config, pluginRuntime) => {
				publisher = pluginRuntime.registerRoomMembershipEvidencePublisher(
					"owned-source",
					"account-a",
				);
			},
		});
		const observedAt = Date.now();
		await expect(
			publisher?.publish({
				evidence: {
					entityId: ENTITY_ID,
					roomId: ROOM_ID,
					state: "member",
					observedAt,
					expiresAt: observedAt + 60_000,
					generation: 1,
				},
				expectedGeneration: null,
			}),
		).rejects.toMatchObject({
			code: "ROOM_MEMBERSHIP_PUBLISHER_ACCOUNT_FORBIDDEN",
		});
	});

	it("checks persisted account ownership atomically instead of trusting room cache", async () => {
		const runtime = await createMembershipRuntime("owned-source", "account-a");
		let publisher: RoomMembershipEvidencePublisher | undefined;
		await runtime.registerPlugin({
			name: "persisted-account-membership-source",
			description: "Uses persisted room ownership",
			connectorSources: [{ source: "owned-source" }],
			init: (_config, pluginRuntime) => {
				publisher = pluginRuntime.registerRoomMembershipEvidencePublisher(
					"owned-source",
					"account-a",
				);
			},
		});
		const cached = await runtime.getRoom(ROOM_ID);
		expect(cached?.metadata?.connectorAccountId).toBe("account-a");
		if (!cached) throw new Error("room fixture must exist");
		await runtime.adapter.upsertRooms([
			{
				...cached,
				id: ROOM_ID,
				agentId: AGENT_ID,
				source: "owned-source",
				type: ChannelType.GROUP,
				metadata: { connectorAccountId: "account-b" },
			},
		]);
		const observedAt = Date.now();
		await expect(
			publisher?.publish({
				evidence: {
					entityId: ENTITY_ID,
					roomId: ROOM_ID,
					state: "member",
					observedAt,
					expiresAt: observedAt + 60_000,
					generation: 1,
				},
				expectedGeneration: null,
			}),
		).rejects.toMatchObject({
			code: "ROOM_MEMBERSHIP_PUBLISHER_ACCOUNT_FORBIDDEN",
		});
	});

	it("revokes async init descendants after plugin unload", async () => {
		const runtime = await createMembershipRuntime();
		let releaseGate: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let deferredPublish: Promise<unknown> | undefined;
		await runtime.registerPlugin({
			name: "deferred-membership-source",
			description: "Schedules work from plugin init",
			connectorSources: [{ source: "owned-source" }],
			init: (_config, pluginRuntime) => {
				const publisher = pluginRuntime.registerRoomMembershipEvidencePublisher(
					"owned-source",
					"account-a",
				);
				deferredPublish = (async () => {
					await gate;
					const observedAt = Date.now();
					return publisher.publish({
						evidence: {
							entityId: ENTITY_ID,
							roomId: ROOM_ID,
							state: "member",
							observedAt,
							expiresAt: observedAt + 60_000,
							generation: 1,
						},
						expectedGeneration: null,
					});
				})();
			},
		});

		await runtime.unloadPlugin("deferred-membership-source");
		releaseGate?.();
		await expect(deferredPublish).rejects.toMatchObject({
			code: "ROOM_MEMBERSHIP_PUBLISHER_REVOKED",
		});
	});

	it("never activates a publisher captured by a failed plugin init", async () => {
		const runtime = await createMembershipRuntime();
		let releaseGate: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let deferredPublish: Promise<unknown> | undefined;
		await expect(
			runtime.registerPlugin({
				name: "failed-membership-source",
				description: "Fails after capturing a publisher",
				connectorSources: [{ source: "owned-source" }],
				init: (_config, pluginRuntime) => {
					const publisher =
						pluginRuntime.registerRoomMembershipEvidencePublisher(
							"owned-source",
							"account-a",
						);
					deferredPublish = (async () => {
						await gate;
						const observedAt = Date.now();
						return publisher.publish({
							evidence: {
								entityId: ENTITY_ID,
								roomId: ROOM_ID,
								state: "member",
								observedAt,
								expiresAt: observedAt + 60_000,
								generation: 1,
							},
							expectedGeneration: null,
						});
					})();
					throw new Error("injected init failure");
				},
			}),
		).rejects.toThrow("injected init failure");

		releaseGate?.();
		await expect(deferredPublish).rejects.toMatchObject({
			code: "ROOM_MEMBERSHIP_PUBLISHER_REVOKED",
		});
	});

	it("drains an in-flight publish before unload completes", async () => {
		const runtime = await createMembershipRuntime("owned-source");
		let publisher: RoomMembershipEvidencePublisher | undefined;
		await runtime.registerPlugin({
			name: "drained-membership-source",
			description: "Owns an in-flight membership publication",
			connectorSources: [{ source: "owned-source" }],
			init: (_config, pluginRuntime) => {
				publisher = pluginRuntime.registerRoomMembershipEvidencePublisher(
					"owned-source",
					"account-a",
				);
			},
		});
		const originalUpdate = runtime.adapter.updateRoomMembershipEvidence.bind(
			runtime.adapter,
		);
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseUpdate: (() => void) | undefined;
		const updateGate = new Promise<void>((resolve) => {
			releaseUpdate = resolve;
		});
		runtime.adapter.updateRoomMembershipEvidence = async (update) => {
			markStarted?.();
			await updateGate;
			return originalUpdate(update);
		};
		const observedAt = Date.now();
		const publication = publisher?.publish({
			evidence: {
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				state: "member",
				observedAt,
				expiresAt: observedAt + 60_000,
				generation: 1,
			},
			expectedGeneration: null,
		});
		await started;
		let unloadCompleted = false;
		const unload = runtime
			.unloadPlugin("drained-membership-source")
			.then(() => {
				unloadCompleted = true;
			});
		await Promise.resolve();
		expect(unloadCompleted).toBe(false);
		releaseUpdate?.();
		await expect(publication).resolves.toMatchObject({ status: "updated" });
		await unload;
		expect(unloadCompleted).toBe(true);
	});
});
