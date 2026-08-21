/**
 * Covers the inbound DM policy gate and attachment persistence: the default
 * "pairing" policy holds unknown senders through the core PairingService code
 * handshake instead of defaulting open (and fails closed when that service is
 * not registered), statically allowlisted and pairing-approved senders pass,
 * and attachment URLs persisted on memories never carry the BlueBubbles
 * server password. Uses a stub runtime with a mocked PairingService and
 * message service — no live server.
 */
import { type IAgentRuntime, ServiceType, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BlueBubblesService } from "../src/service";
import type { BlueBubblesHandle, BlueBubblesMessage } from "../src/types";

const SERVER_URL = "http://localhost:1234";
const SERVER_PASSWORD = "super-secret";

function makeRuntime(
	settings: Record<string, unknown>,
	options: {
		pairingAllowed: boolean;
		pairingRequestCreated?: boolean;
		pairingService?: boolean;
	},
) {
	const pairingService = {
		isAllowed: vi.fn(async () => options.pairingAllowed),
		upsertRequest: vi.fn(async () => ({
			code: "PAIRCODE1",
			created: options.pairingRequestCreated ?? true,
		})),
		claimPairingReply: vi.fn(() => true),
	};
	const handleMessage = vi.fn(async () => undefined);
	const createMemory = vi.fn(async () => undefined);
	const runtime = {
		agentId: "agent-1" as UUID,
		character: { name: "Test Agent", settings: {} },
		getSetting: (key: string) => settings[key],
		getService: (serviceType: string) =>
			serviceType === ServiceType.PAIRING && options.pairingService !== false
				? pairingService
				: null,
		getEntityById: vi.fn(async () => null),
		createEntity: vi.fn(async () => undefined),
		ensureConnection: vi.fn(async () => undefined),
		createMemory,
		updateMemory: vi.fn(async () => true),
		getRoom: vi.fn(async () => ({ id: "room-1" as UUID })),
		messageService: { handleMessage },
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
	return { runtime, pairingService, createMemory, handleMessage };
}

function makeHandle(address: string): BlueBubblesHandle {
	return {
		address,
		service: "iMessage",
		country: null,
		originalROWID: 1,
		uncanonicalizedId: null,
	};
}

function makeMessage(
	overrides: Partial<BlueBubblesMessage> = {},
): BlueBubblesMessage {
	const handle = makeHandle("+1 (415) 555-2671");
	return {
		guid: "msg-1",
		text: "hello",
		subject: null,
		country: null,
		handle,
		handleId: 1,
		otherHandle: 0,
		chats: [
			{
				guid: "iMessage;-;+14155552671",
				chatIdentifier: "+14155552671",
				displayName: "Alice",
				participants: [handle],
				lastMessage: null,
				style: 45,
				isArchived: false,
				isFiltered: false,
				isPinned: false,
				hasUnreadMessages: false,
			},
		],
		attachments: [],
		expressiveSendStyleId: null,
		dateCreated: 1710969600000,
		dateRead: null,
		dateDelivered: null,
		isFromMe: false,
		isDelayed: false,
		isAutoReply: false,
		isSystemMessage: false,
		isServiceMessage: false,
		isForward: false,
		isArchived: false,
		hasDdResults: false,
		hasPayloadData: false,
		threadOriginatorGuid: null,
		threadOriginatorPart: null,
		associatedMessageGuid: null,
		associatedMessageType: null,
		balloonBundleId: null,
		dateEdited: null,
		error: 0,
		itemType: 0,
		groupTitle: null,
		groupActionType: 0,
		payloadData: null,
		...overrides,
	};
}

function baseSettings(overrides: Record<string, unknown> = {}) {
	return {
		BLUEBUBBLES_SERVER_URL: SERVER_URL,
		BLUEBUBBLES_PASSWORD: SERVER_PASSWORD,
		BLUEBUBBLES_SEND_READ_RECEIPTS: "false",
		...overrides,
	};
}

describe("BlueBubbles inbound DM pairing gate", () => {
	it("holds an unpaired sender and sends the pairing-code reply", async () => {
		const { runtime, pairingService, createMemory, handleMessage } =
			makeRuntime(baseSettings(), { pairingAllowed: false });
		const service = new BlueBubblesService(runtime);
		const sendMessage = vi
			.spyOn(service, "sendMessage")
			.mockResolvedValue({ guid: "reply-1", dateCreated: 1 });

		await service.handleWebhook({
			type: "new-message",
			data: makeMessage(),
		});

		expect(pairingService.isAllowed).toHaveBeenCalledWith(
			"imessage",
			"+14155552671",
		);
		expect(pairingService.upsertRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: "imessage",
				senderId: "+14155552671",
			}),
		);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0]?.[0]).toBe("iMessage;-;+14155552671");
		expect(sendMessage.mock.calls[0]?.[1]).toContain("PAIRCODE1");
		expect(createMemory).not.toHaveBeenCalled();
		expect(handleMessage).not.toHaveBeenCalled();
	});

	it("does not re-send the pairing code for an already-pending sender", async () => {
		const { runtime, createMemory } = makeRuntime(baseSettings(), {
			pairingAllowed: false,
			pairingRequestCreated: false,
		});
		const service = new BlueBubblesService(runtime);
		const sendMessage = vi.spyOn(service, "sendMessage");

		await service.handleWebhook({
			type: "new-message",
			data: makeMessage(),
		});

		expect(sendMessage).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("admits a pairing-approved sender and persists bare attachment URLs", async () => {
		const { runtime, pairingService, createMemory, handleMessage } =
			makeRuntime(baseSettings(), { pairingAllowed: true });
		const service = new BlueBubblesService(runtime);

		await service.handleWebhook({
			type: "new-message",
			data: makeMessage({
				attachments: [
					{
						guid: "att-1",
						originalROWID: 1,
						uti: "public.png",
						mimeType: "image/png",
						transferName: "photo.png",
						totalBytes: 128,
						isOutgoing: false,
						hideAttachment: false,
						isSticker: false,
						hasLivePhoto: false,
						height: null,
						width: null,
						metadata: null,
					},
				],
			}),
		});

		expect(pairingService.isAllowed).toHaveBeenCalledWith(
			"imessage",
			"+14155552671",
		);
		expect(pairingService.upsertRequest).not.toHaveBeenCalled();
		expect(createMemory).toHaveBeenCalledTimes(1);
		const memory = createMemory.mock.calls[0]?.[0] as {
			content: { attachments?: Array<{ url: string }> };
		};
		expect(memory.content.attachments).toHaveLength(1);
		expect(memory.content.attachments?.[0]?.url).toBe(
			`${SERVER_URL}/api/v1/attachment/att-1`,
		);
		expect(memory.content.attachments?.[0]?.url).not.toContain("password");
		expect(memory.content.attachments?.[0]?.url).not.toContain(SERVER_PASSWORD);
		expect(handleMessage).toHaveBeenCalledTimes(1);
	});

	it("admits a statically allowlisted sender without consulting pairing", async () => {
		const { runtime, pairingService, createMemory } = makeRuntime(
			baseSettings({ BLUEBUBBLES_ALLOW_FROM: "+14155552671" }),
			{ pairingAllowed: false },
		);
		const service = new BlueBubblesService(runtime);

		await service.handleWebhook({
			type: "new-message",
			data: makeMessage(),
		});

		expect(pairingService.isAllowed).not.toHaveBeenCalled();
		expect(createMemory).toHaveBeenCalledTimes(1);
	});

	it("keeps the allowlist policy closed without creating pairing requests", async () => {
		const { runtime, pairingService, createMemory } = makeRuntime(
			baseSettings({ BLUEBUBBLES_DM_POLICY: "allowlist" }),
			{ pairingAllowed: false },
		);
		const service = new BlueBubblesService(runtime);

		await service.handleWebhook({
			type: "new-message",
			data: makeMessage(),
		});

		expect(pairingService.isAllowed).not.toHaveBeenCalled();
		expect(pairingService.upsertRequest).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("fails closed and reports when the PairingService is not registered", async () => {
		const { runtime, createMemory, handleMessage } = makeRuntime(
			baseSettings(),
			{ pairingAllowed: false, pairingService: false },
		);
		const service = new BlueBubblesService(runtime);
		const sendMessage = vi
			.spyOn(service, "sendMessage")
			.mockResolvedValue({ guid: "reply-1", dateCreated: 1 });

		await service.handleWebhook({
			type: "new-message",
			data: makeMessage(),
		});

		// A missing PairingService under the "pairing" policy is a host
		// misconfiguration: the sender is denied, the runtime error reporter
		// fires, and only the static "temporarily unavailable" reply goes out.
		expect(runtime.reportError).toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
		expect(handleMessage).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0]?.[1]).not.toContain("PAIRCODE1");
	});
});
