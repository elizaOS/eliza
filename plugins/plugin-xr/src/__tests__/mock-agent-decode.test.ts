/**
 * MockAgentServer decode-error observability. Boots the real ws mock on an
 * ephemeral port, connects a real client, and asserts that a malformed inbound
 * frame is RECORDED (not silently swallowed) while well-formed traffic is
 * unaffected — the fix that replaced two empty catches with observable
 * decode-error capture (#12275).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MockAgentServer } from "../../simulator/src/mock-agent.ts";
import { encodeBinaryFrame } from "../protocol.ts";

let server: MockAgentServer;
const PORT = 31801;

function connect(): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
	return new Promise((resolve, reject) => {
		ws.on("open", () => resolve(ws));
		ws.on("error", reject);
	});
}

function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
	server = new MockAgentServer({ port: PORT });
	await server.start();
});

afterEach(async () => {
	await server.stop();
});

describe("MockAgentServer decode-error recording", () => {
	it("records a malformed text control frame instead of swallowing it", async () => {
		const ws = await connect();
		ws.send("this is not json {{{");
		await flush();
		ws.close();

		expect(server.decodeErrors).toHaveLength(1);
		expect(server.decodeErrors[0]?.kind).toBe("text");
		expect(server.decodeErrors[0]?.error).toBeInstanceOf(Error);
	});

	it("records a malformed binary frame (bad header length prefix)", async () => {
		const ws = await connect();
		// A binary buffer whose declared header length overruns the payload.
		const bogus = Buffer.from([0x00, 0x00, 0x00, 0xff, 0x7b]);
		ws.send(bogus, { binary: true });
		await flush();
		ws.close();

		expect(server.decodeErrors).toHaveLength(1);
		expect(server.decodeErrors[0]?.kind).toBe("binary");
	});

	it("leaves decodeErrors empty for well-formed traffic", async () => {
		const ws = await connect();
		ws.send(JSON.stringify({ type: "hello" }));
		const header = {
			type: "audio" as const,
			ts: Date.now(),
			sampleRate: 16000,
			encoding: "pcm-f32" as const,
		};
		ws.send(encodeBinaryFrame(header, Buffer.from([1, 2, 3, 4])), {
			binary: true,
		});
		await flush();
		ws.close();

		expect(server.decodeErrors).toHaveLength(0);
		expect(server.receivedControls).toHaveLength(1);
		expect(server.receivedFrames).toHaveLength(1);
	});
});
