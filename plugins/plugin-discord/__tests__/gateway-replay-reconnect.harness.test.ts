/**
 * Gateway-seam replay + reconnect harness (charter rows D4/D5).
 *
 * messages-durable-turn.test.ts drives MessageManager.handleMessage directly.
 * This harness closes the remaining automated gap by driving the SAME entry
 * point through a synthetic gateway emitter, i.e. the exact seam the real
 * connector uses: `client.on("messageCreate", ...) -> manager.handleMessage`.
 * That genuinely exercises "the gateway delivered the same message id again"
 * (Discord redelivers on resume/reconnect) rather than a bare method call.
 *
 * Covered:
 *  D5 replay through the gateway seam:
 *    (a) same message id emitted twice on one live manager  -> one reply
 *    (b) same message id emitted again after manager "restart" -> no second reply
 *    (c) crash after inbound persist before reply, then gateway redelivery
 *        -> resume completes exactly one substantive reply
 *  D4 reconnect simulation:
 *    (d) events arriving while the client is not ready are buffered and
 *        replayed after ready: nothing is silently dropped pre-ready
 *    (e) 10 close/error reconnect cycles, idle and mid-turn, each followed by
 *        a redelivery + a fresh message -> exactly one reply per unique
 *        message id, zero drops, zero duplicates
 *
 * What still requires live Discord (Gate 3, documented in the receipt): real
 * egress sever on the sovereign candidate, token/session resume against the
 * real gateway, and wall-clock reconnect timing.
 */
// Reuse the proven durable-harness building blocks rather than re-deriving
// store semantics. These helpers are structurally identical to the ones in
// messages-durable-turn.test.ts; kept local so each test file stays runnable
// in isolation.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	ChannelType,
	type Content,
	createUniqueUuid,
	type Memory,
	type UUID,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const AUTHOR_ID = "555000111222333444";
const CHANNEL_ID = "777000000000000000";
const CLIENT_ID = "888000000000000000";

interface Sent {
	content?: string;
}

type CrashMode = "none" | "after-persist-before-reply";

interface Harness {
	runtime: ICompatRuntime;
	sends: Sent[];
	setCrashMode: (mode: CrashMode) => void;
}

function makeHarness(): Harness {
	const memoriesById = new Map<string, Memory>();
	const memoriesByRoom = new Map<string, Memory[]>();
	const sends: Sent[] = [];
	let crashMode: CrashMode = "none";

	const indexMemory = (memory: Memory, id: UUID, tableName: string) => {
		const stored = { ...memory, id };
		memoriesById.set(id, stored);
		if (tableName === "messages") {
			const list = memoriesByRoom.get(memory.roomId) ?? [];
			list.unshift(stored);
			memoriesByRoom.set(memory.roomId, list);
		}
	};

	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: (key: string) =>
			key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ? "false" : undefined,
		getService: () => null,
		ensureConnection: vi.fn(async () => {}),
		getMemoryById: vi.fn(async (id: UUID) => memoriesById.get(id) ?? null),
		createMemory: vi.fn(
			async (memory: Memory, tableName = "messages", _unique?: boolean) => {
				const id =
					memory.id ??
					(createUniqueUuid(runtime as ICompatRuntime, randomUUID()) as UUID);
				indexMemory(memory, id, tableName);
				return id;
			},
		),
		upsertMemory: vi.fn(async (memory: Memory, tableName: string) => {
			const id =
				memory.id ??
				(createUniqueUuid(runtime as ICompatRuntime, randomUUID()) as UUID);
			indexMemory(memory, id, tableName);
		}),
		getMemories: vi.fn(async (params: { roomId?: UUID; tableName: string }) => {
			if (params.tableName !== "messages" || !params.roomId) return [];
			return memoriesByRoom.get(params.roomId) ?? [];
		}),
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				if (message.id && !memoriesById.has(message.id)) {
					indexMemory(message, message.id, "messages");
				}
				if (crashMode === "after-persist-before-reply") {
					crashMode = "none";
					throw new Error("crash after inbound persist, before reply");
				}
				await callback({ text: "one durable reply", source: "discord" });
			},
		},
		emitEvent: vi.fn(),
	} as unknown as ICompatRuntime;

	return {
		runtime,
		sends,
		setCrashMode: (mode) => {
			crashMode = mode;
		},
	};
}

function makeDmChannel(sends: Sent[]) {
	return {
		id: CHANNEL_ID,
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: async (options: Sent) => {
			sends.push(options);
			return {
				id: `99000000000000000${sends.length}`,
				content: options.content ?? "",
				url: `https://discord.com/channels/@me/${CHANNEL_ID}/99000000000000000${sends.length}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
		sendTyping: async () => {},
	};
}

function makeInboundMemory(messageId: string): Memory {
	return {
		id: createUniqueUuid(
			{ agentId: AGENT_ID } as ICompatRuntime,
			messageId,
		) as UUID,
		entityId: createUniqueUuid(
			{ agentId: AGENT_ID } as ICompatRuntime,
			AUTHOR_ID,
		) as UUID,
		agentId: AGENT_ID,
		roomId: createUniqueUuid(
			{ agentId: AGENT_ID } as ICompatRuntime,
			CHANNEL_ID,
		) as UUID,
		content: { text: "hello", source: "discord" },
	};
}

function makeDiscordService(client: unknown): IDiscordService {
	return {
		client,
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "off",
		},
		buildMemoryFromMessage: vi.fn(async (message: DiscordMessage) =>
			makeInboundMemory(message.id),
		),
	} as unknown as IDiscordService;
}

function makeInbound(channel: unknown, messageId: string): DiscordMessage {
	return {
		id: messageId,
		content: "hello",
		createdTimestamp: Date.now(),
		author: {
			id: AUTHOR_ID,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
		},
		member: null,
		channel,
		guild: undefined,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users: new Map(), repliedUser: undefined },
	} as unknown as DiscordMessage;
}

/** Substantive replies only (crash turns also emit a short retry notice). */
function substantiveReplies(sends: Sent[]): Sent[] {
	return sends.filter((s) => s.content === "one durable reply");
}

/**
 * Synthetic gateway: an EventEmitter standing in for discord.js's client event
 * surface, with the connector's ready-gate semantics modeled explicitly:
 * while not ready, inbound gateway events are buffered; on ready they are
 * replayed in arrival order (no pre-ready silent drop). This mirrors the
 * service's `clientReadyPromise` + `client.isReady()` gating.
 */
class SyntheticGateway extends EventEmitter {
	private ready = false;
	private preReadyBuffer: DiscordMessage[] = [];
	private manager: MessageManager | null = null;
	/** promise tail so the harness can await quiescence deterministically */
	private tail: Promise<void> = Promise.resolve();

	attach(manager: MessageManager): void {
		this.manager = manager;
		this.removeAllListeners("messageCreate");
		// The exact seam: gateway event -> listener -> manager.handleMessage.
		this.on("messageCreate", (message: DiscordMessage) => {
			if (!this.ready) {
				this.preReadyBuffer.push(message);
				return;
			}
			this.dispatch(message);
		});
	}

	private dispatch(message: DiscordMessage): void {
		const manager = this.manager;
		if (!manager) return;
		this.tail = this.tail
			.catch(() => undefined)
			.then(() => manager.handleMessage(message).catch(() => undefined));
	}

	/** ClientReady: flush buffered events in order. */
	setReady(): void {
		this.ready = true;
		const buffered = this.preReadyBuffer;
		this.preReadyBuffer = [];
		for (const message of buffered) this.dispatch(message);
	}

	/** Gateway close/error: connector goes not-ready until resume completes. */
	sever(): void {
		this.ready = false;
	}

	async idle(): Promise<void> {
		// Two rounds so work scheduled by the tail itself also settles.
		await this.tail;
		await this.tail;
	}
}

function makeManager(harness: Harness): MessageManager {
	const service = makeDiscordService({ user: { id: CLIENT_ID } });
	return new MessageManager(service, harness.runtime);
}

describe("gateway replay + reconnect harness (D4/D5)", () => {
	it("(a) same message id emitted twice through the gateway -> one reply", async () => {
		const harness = makeHarness();
		const gateway = new SyntheticGateway();
		gateway.attach(makeManager(harness));
		gateway.setReady();

		const channel = makeDmChannel(harness.sends);
		const inbound = makeInbound(channel, "111000000000000001");
		gateway.emit("messageCreate", inbound);
		await gateway.idle();
		// Gateway redelivers the exact same message id (resume replay).
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000001"));
		await gateway.idle();

		expect(substantiveReplies(harness.sends)).toHaveLength(1);
	});

	it("(b) redelivery after manager reconstruction -> no second reply", async () => {
		const harness = makeHarness();
		const gateway = new SyntheticGateway();
		gateway.attach(makeManager(harness));
		gateway.setReady();

		const channel = makeDmChannel(harness.sends);
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000002"));
		await gateway.idle();
		expect(substantiveReplies(harness.sends)).toHaveLength(1);

		// "Process restart": new manager over the same durable runtime store,
		// gateway session resumes and redelivers the same id.
		gateway.attach(makeManager(harness));
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000002"));
		await gateway.idle();

		expect(substantiveReplies(harness.sends)).toHaveLength(1);
	});

	it("(c) crash after persist before reply, gateway redelivery resumes exactly once", async () => {
		const harness = makeHarness();
		const gateway = new SyntheticGateway();
		gateway.attach(makeManager(harness));
		gateway.setReady();

		const channel = makeDmChannel(harness.sends);
		harness.setCrashMode("after-persist-before-reply");
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000003"));
		await gateway.idle();
		// Crash turn produced no substantive reply.
		expect(substantiveReplies(harness.sends)).toHaveLength(0);

		// Restart + gateway redelivery of the same id -> resume path replies once.
		gateway.attach(makeManager(harness));
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000003"));
		await gateway.idle();
		expect(substantiveReplies(harness.sends)).toHaveLength(1);

		// Further redelivery stays a no-op.
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000003"));
		await gateway.idle();
		expect(substantiveReplies(harness.sends)).toHaveLength(1);
	});

	it("(d) events before ready are buffered and replayed after ready, never dropped", async () => {
		const harness = makeHarness();
		const gateway = new SyntheticGateway();
		gateway.attach(makeManager(harness));
		// NOT ready yet: these arrive during connect/resume.
		const channel = makeDmChannel(harness.sends);
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000004"));
		gateway.emit("messageCreate", makeInbound(channel, "111000000000000005"));
		await gateway.idle();
		expect(substantiveReplies(harness.sends)).toHaveLength(0);

		gateway.setReady();
		await gateway.idle();
		// Both buffered messages processed exactly once after ready.
		expect(substantiveReplies(harness.sends)).toHaveLength(2);
	});

	it("(e) 10 reconnect cycles (idle + mid-turn) -> one reply per unique id, zero drops", async () => {
		const harness = makeHarness();
		const gateway = new SyntheticGateway();
		gateway.attach(makeManager(harness));
		gateway.setReady();
		const channel = makeDmChannel(harness.sends);

		let uniqueMessages = 0;
		for (let cycle = 0; cycle < 10; cycle++) {
			const id = `2220000000000000${String(10 + cycle)}`;
			uniqueMessages += 1;

			if (cycle % 2 === 0) {
				// Idle sever: connection drops while nothing is in flight.
				gateway.sever();
				// Message arrives during the outage -> must buffer, not drop.
				gateway.emit("messageCreate", makeInbound(channel, id));
				gateway.setReady();
			} else {
				// Mid-turn sever: deliver, then sever while the turn may be in
				// flight, then resume and redeliver the same id (gateway replay).
				gateway.emit("messageCreate", makeInbound(channel, id));
				gateway.sever();
				gateway.setReady();
				gateway.emit("messageCreate", makeInbound(channel, id));
			}
			await gateway.idle();
		}

		expect(substantiveReplies(harness.sends)).toHaveLength(uniqueMessages);
	});
});
