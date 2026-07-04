/**
 * XR smartglasses bridge tests verify headset WebSocket messages are routed
 * into SmartglassesService for native G1 frames and microphone audio.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { G1Command } from "../protocol/smartglasses.ts";
import {
	SMARTGLASSES_SERVICE_NAME,
	SmartglassesService,
} from "../services/smartglasses-service.ts";
import { XRSessionService } from "../services/xr-session-service.ts";

describe("XR smartglasses bridge", () => {
	let xrService: XRSessionService | null = null;
	let client: WebSocket | null = null;

	afterEach(async () => {
		client?.close();
		client = null;
		if (xrService) await xrService.stop();
		xrService = null;
	});

	it("routes Even Realities native g1_raw and mic_lc3 frames into SmartglassesService", async () => {
		const smartglasses = new SmartglassesService();
		const runtime = createRuntime(smartglasses);
		xrService = (await XRSessionService.start(runtime)) as XRSessionService;
		const port = xrService.getWebSocketPort();
		expect(port).toBeTypeOf("number");

		client = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(client);
		client.send(
			JSON.stringify({
				type: "hello",
				deviceType: "even-realities",
				sessionId: "android-test",
			}),
		);
		await waitForMessage(client, (message) => message.type === "ready");

		client.send(
			JSON.stringify({
				type: "g1_raw",
				side: "right",
				data: [G1Command.StartAi, 0x01],
			}),
		);
		const micControl = await waitForMessage(
			client,
			(message) => message.type === "mic_control",
		);
		expect(micControl).toEqual({ type: "mic_control", enabled: true });
		expect(smartglasses.getStatus()).toMatchObject({
			microphoneEnabled: true,
			lastEvent: {
				label: "single_tap",
			},
		});

		client.send(
			JSON.stringify({
				type: "mic_lc3",
				side: "right",
				sampleRate: 16000,
				sequence: 7,
				lc3: [1, 2, 3, 4],
			}),
		);
		await waitForStatus(
			smartglasses,
			(status) =>
				status.audioChunksReceived === 1 &&
				status.lastAudioEncoding === "lc3" &&
				status.lastAudioSequence === 7,
		);

		client.send(
			JSON.stringify({
				type: "g1_raw",
				side: "right",
				data: [G1Command.StartAi, 0x00],
			}),
		);
		const disable = await waitForMessage(
			client,
			(message) => message.type === "mic_control" && message.enabled === false,
		);
		expect(disable).toEqual({ type: "mic_control", enabled: false });
		expect(smartglasses.getStatus().microphoneEnabled).toBe(false);
	});
});

function createRuntime(smartglasses: SmartglassesService): IAgentRuntime & {
	getService: (name: string) => unknown;
} {
	return {
		agentId: "00000000-0000-4000-8000-000000000001",
		getSetting: (name: string) => (name === "XR_WS_PORT" ? "0" : undefined),
		getService: (name: string) =>
			name === SMARTGLASSES_SERVICE_NAME ? smartglasses : null,
		createEntity: async () => undefined,
		createRoom: async () => undefined,
		addParticipant: async () => undefined,
		createMemory: async () => undefined,
	} as unknown as IAgentRuntime & { getService: (name: string) => unknown };
}

function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
}

function waitForMessage(
	ws: WebSocket,
	predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for WebSocket message"));
		}, 2_000);
		const onMessage = (data: WebSocket.RawData) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			if (!predicate(message)) return;
			cleanup();
			resolve(message);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			ws.off("message", onMessage);
			ws.off("error", onError);
		};
		ws.on("message", onMessage);
		ws.once("error", onError);
	});
}

async function waitForStatus(
	service: SmartglassesService,
	predicate: (status: ReturnType<SmartglassesService["getStatus"]>) => boolean,
): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate(service.getStatus())) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for smartglasses status");
}
