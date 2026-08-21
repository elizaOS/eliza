/**
 * Exercises production BlueBubbles transport, route, service, and runtime
 * behavior against the stateful protocol loopback. All receipts are explicitly
 * mock-only; live provider and native local iMessage qualification are outside
 * this suite.
 */

import { createServer } from "node:http";
import {
	AgentRuntime,
	createCharacter,
	createUniqueUuid,
	InMemoryDatabaseAdapter,
	type Memory,
	type MessageConnectorRegistration,
	type RouteRequest,
	type RouteResponse,
	type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlueBubblesClient, BlueBubblesHttpError } from "./client.js";
import { blueBubblesDataRoutes } from "./data-routes.js";
import { BlueBubblesService } from "./service.js";
import {
	type RunningBlueBubblesLoopback,
	startBlueBubblesLoopback,
} from "./testing/loopback.js";

const AGENT_ID = "00000000-0000-4000-8000-00000000bb01" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-00000000bb02" as UUID;
const CHAT_GUID = "iMessage;-;+14155552671";
const PASSWORD = "personal-p@ss/word?&";
const WEBHOOK_SECRET = "bluebubbles-webhook-secret";
const NOW = Date.parse("2032-04-05T06:07:08.000Z");

const loopbacks: RunningBlueBubblesLoopback[] = [];
const routeServers: Array<{ stop(): Promise<void> }> = [];
const services: BlueBubblesService[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map((service) => service.stop()));
	await Promise.allSettled(
		runtimes.splice(0).map((runtime) => runtime.close()),
	);
	await Promise.allSettled(
		routeServers.splice(0).map((server) => server.stop()),
	);
	await Promise.allSettled(loopbacks.splice(0).map((server) => server.stop()));
	vi.restoreAllMocks();
});

function chat() {
	return {
		guid: CHAT_GUID,
		chatIdentifier: "+14155552671",
		displayName: "Alice",
		participants: [{ address: "+14155552671", service: "iMessage" }],
	};
}

async function loopback(): Promise<RunningBlueBubblesLoopback> {
	const running = await startBlueBubblesLoopback({
		now: () => NOW,
		sleep: async () => undefined,
		accounts: [
			{
				accountId: "personal",
				password: PASSWORD,
				chats: [chat()],
			},
		],
	});
	loopbacks.push(running);
	return running;
}

function protocolMessage(guid: string, text: string): Record<string, unknown> {
	const handle = {
		address: "+14155552671",
		service: "iMessage",
		country: null,
		originalROWID: 1,
		uncanonicalizedId: null,
	};
	return {
		guid,
		text,
		subject: null,
		country: null,
		handle,
		handleId: 1,
		otherHandle: 0,
		chats: [{ ...chat(), participants: [handle], lastMessage: null }],
		attachments: [],
		expressiveSendStyleId: null,
		dateCreated: NOW,
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
	};
}

async function productionRuntime(serverUrl: string): Promise<{
	runtime: AgentRuntime;
	service: BlueBubblesService;
}> {
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: createCharacter({ name: "BlueBubbles Contract Agent" }),
		adapter: new InMemoryDatabaseAdapter(),
		disableBasicCapabilities: true,
		logLevel: "fatal",
	});
	const settings: Record<string, string> = {
		BLUEBUBBLES_SERVER_URL: serverUrl,
		BLUEBUBBLES_PASSWORD: PASSWORD,
		BLUEBUBBLES_WEBHOOK_SECRET: WEBHOOK_SECRET,
		BLUEBUBBLES_DM_POLICY: "open",
		BLUEBUBBLES_SEND_READ_RECEIPTS: "false",
	};
	vi.spyOn(runtime, "getSetting").mockImplementation((key) => settings[key]);
	await runtime.initialize();
	runtimes.push(runtime);
	const service = await BlueBubblesService.start(runtime);
	services.push(service);
	vi.spyOn(runtime, "getService").mockImplementation((serviceType) =>
		serviceType === BlueBubblesService.serviceType ? service : null,
	);
	BlueBubblesService.registerSendHandlers(runtime, service);
	return { runtime, service };
}

async function startProductionWebhookRoute(runtime: AgentRuntime): Promise<{
	url: string;
	waitForRequests(count: number): Promise<void>;
}> {
	const route = blueBubblesDataRoutes.find(
		(candidate) =>
			candidate.type === "POST" && candidate.path === "/webhooks/bluebubbles",
	);
	if (!route)
		throw new Error("production BlueBubbles webhook route is missing");
	let startedRequests = 0;
	const requestWaiters = new Set<() => void>();
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		let status = 200;
		const routeResponse = {
			status(code: number) {
				status = code;
				return this;
			},
			json(body: unknown) {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
				return this;
			},
		} as unknown as RouteResponse;
		const rawBody = Buffer.concat(chunks).toString("utf8");
		const routeRequest = {
			method: request.method,
			url: request.url,
			headers: request.headers,
			body: rawBody ? JSON.parse(rawBody) : undefined,
		} as unknown as RouteRequest;
		startedRequests += 1;
		for (const resolve of requestWaiters) resolve();
		requestWaiters.clear();
		await route.handler(routeRequest, routeResponse, runtime);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("production webhook test route did not bind");
	}
	routeServers.push({
		stop: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	});
	return {
		url: `http://127.0.0.1:${address.port}/webhooks/bluebubbles`,
		async waitForRequests(count) {
			while (startedRequests < count) {
				await new Promise<void>((resolve) => requestWaiters.add(resolve));
			}
		},
	};
}

describe("BlueBubbles production contract over the external-server loopback", () => {
	it("keeps tempGuid sends idempotent across ambiguous acceptance and deterministic reset", async () => {
		const upstream = await loopback();
		expect(upstream.owner).toBe("bluebubbles-external");
		const client = new BlueBubblesClient({
			serverUrl: upstream.url,
			password: PASSWORD,
		});
		const initial = upstream.snapshot();
		const first = await client.sendMessage(CHAT_GUID, "hello", {
			tempGuid: "send-once",
		});
		const replay = await client.sendMessage(CHAT_GUID, "hello", {
			tempGuid: "send-once",
		});
		expect(replay.guid).toBe(first.guid);

		upstream.fault("POST", "/api/v1/message/text", {
			type: "status",
			status: 503,
		});
		await expect(
			client.sendMessage(CHAT_GUID, "ambiguous", {
				tempGuid: "ambiguous-once",
			}),
		).rejects.toMatchObject({
			name: "BlueBubblesHttpError",
			statusCode: 503,
			acceptance: "ambiguous",
		});
		const recovered = await client.sendMessage(CHAT_GUID, "ambiguous", {
			tempGuid: "ambiguous-once",
		});
		expect(recovered.guid).toContain("msg-personal");
		expect(
			upstream
				.snapshot()
				.accounts[0]?.messages.filter(
					(message) => message.tempGuid === "ambiguous-once",
				),
		).toHaveLength(1);
		const attachment = await client.sendAttachment(
			CHAT_GUID,
			"/tmp/scenario-photo.png",
			{ tempGuid: "attachment-once" },
		);
		const attachmentReplay = await client.sendAttachment(
			CHAT_GUID,
			"/tmp/scenario-photo.png",
			{ tempGuid: "attachment-once" },
		);
		expect(attachmentReplay.guid).toBe(attachment.guid);
		expect((await client.getChat(CHAT_GUID)).guid).toBe(CHAT_GUID);
		await client.reactToMessage(CHAT_GUID, first.guid, "love");
		await client.editMessage(first.guid, "edited hello");
		expect(
			(await client.getMessages(CHAT_GUID)).find(
				(message) => message.guid === first.guid,
			)?.text,
		).toBe("edited hello");
		await client.unsendMessage(first.guid);
		expect(
			(await client.getMessages(CHAT_GUID)).some(
				(message) => message.guid === first.guid,
			),
		).toBe(false);
		expect(
			upstream.receipts.every((receipt) => receipt.evidence === "mock-only"),
		).toBe(true);
		expect(JSON.stringify(upstream.receipts)).not.toContain(PASSWORD);

		expect(upstream.reset()).toEqual(initial);
	});

	it("drives the production connector and resumes persisted-but-unprocessed ingress exactly once", async () => {
		const upstream = await loopback();
		const { runtime, service } = await productionRuntime(upstream.url);
		expect(service.getIsRunning()).toBe(true);
		const connectors =
			runtime.getMessageConnectors() as MessageConnectorRegistration[];
		expect(
			connectors.some((connector) => connector.source === "bluebubbles"),
		).toBe(true);
		const outbound = await runtime.sendMessageToTarget(
			{ source: "bluebubbles", channelId: CHAT_GUID, roomId: ROOM_ID },
			{ text: "production egress", agentVoiced: true },
		);
		const outboundMemory =
			outbound && "kind" in outbound
				? outbound.kind === "delivered" ||
					outbound.kind === "partially_delivered"
					? outbound.memories[0]
					: undefined
				: outbound;
		expect(outboundMemory).toMatchObject({
			metadata: {
				accountId: "default",
				bluebubblesChatGuid: CHAT_GUID,
			},
		});

		const webhookRoute = await startProductionWebhookRoute(runtime);
		const enteredFirstProcessing = Promise.withResolvers<void>();
		const releaseFirstProcessing = Promise.withResolvers<void>();
		let successfulProcessing = 0;
		let attempts = 0;
		vi.spyOn(runtime.messageService, "handleMessage").mockImplementation(
			async () => {
				attempts += 1;
				if (attempts === 1) {
					enteredFirstProcessing.resolve();
					await releaseFirstProcessing.promise;
					throw new Error("injected process failure after persistence");
				}
				successfulProcessing += 1;
				return undefined;
			},
		);

		const event = {
			id: "inbound-event-1",
			sequence: 1,
			accountId: "personal",
			type: "new-message" as const,
			data: protocolMessage("inbound-message-1", "retry me"),
		};
		expect(
			(
				await upstream.deliverWebhook(webhookRoute.url, event, "wrong-secret", {
					maxAttempts: 1,
				})
			)[0]?.status,
		).toBe(401);

		const firstDelivery = upstream.deliverWebhook(
			webhookRoute.url,
			event,
			WEBHOOK_SECRET,
			{ maxAttempts: 1 },
		);
		await enteredFirstProcessing.promise;
		const memoryId = createUniqueUuid(
			runtime,
			"bluebubbles:inbound-message-1",
		) as UUID;
		const persistedBeforeFailure = await runtime.getMemoryById(memoryId);
		expect(persistedBeforeFailure).toBeTruthy();
		expect(
			(persistedBeforeFailure?.metadata as Record<string, unknown> | undefined)
				?.bluebubblesProcessingCompleted,
		).not.toBe(true);

		const concurrentDuplicate = upstream.deliverWebhook(
			webhookRoute.url,
			event,
			WEBHOOK_SECRET,
			{ maxAttempts: 1 },
		);
		await webhookRoute.waitForRequests(3);
		releaseFirstProcessing.resolve();
		expect((await firstDelivery)[0]?.status).toBe(500);
		expect((await concurrentDuplicate)[0]?.status).toBe(500);
		expect(attempts).toBe(1);

		expect(
			(
				await upstream.deliverWebhook(webhookRoute.url, event, WEBHOOK_SECRET, {
					maxAttempts: 1,
				})
			)[0]?.status,
		).toBe(200);
		expect(successfulProcessing).toBe(1);
		expect(attempts).toBe(2);
		expect(
			(
				await upstream.deliverWebhook(webhookRoute.url, event, WEBHOOK_SECRET, {
					maxAttempts: 1,
				})
			)[0]?.status,
		).toBe(200);
		expect(attempts).toBe(2);
		const completed = (await runtime.getMemoryById(memoryId)) as Memory;
		expect(
			(completed.metadata as Record<string, unknown> | undefined)
				?.bluebubblesProcessingCompleted,
		).toBe(true);
		expect(
			upstream.receipts
				.filter(
					(receipt) =>
						receipt.kind === "webhook" && receipt.idempotencyKey === event.id,
				)
				.map((receipt) => receipt.detail.status),
		).toEqual([401, 500, 500, 200, 200]);
	});

	it("classifies rejected provider responses without claiming acceptance", async () => {
		const upstream = await loopback();
		const client = new BlueBubblesClient({
			serverUrl: upstream.url,
			password: PASSWORD,
		});
		let caught: unknown;
		try {
			await client.sendMessage("iMessage;-;+19999999999", "invalid");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(BlueBubblesHttpError);
		expect(caught).toMatchObject({ statusCode: 422, acceptance: "rejected" });
	});
});
