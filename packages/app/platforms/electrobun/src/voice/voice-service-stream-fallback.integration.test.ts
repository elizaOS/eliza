import { describe, expect, it } from "vitest";
import { VoiceError } from "./errors";
import { RuntimeHttpVoiceAdapter } from "./voice-runtime-adapter";
import { VoiceService } from "./voice-service";

const ENV = {
	ELIZA_VOICE_LIVE_RUNTIME: "1",
	ELIZA_VOICE_STREAMING: "1",
};

type StreamRoute = () => Response;

function sse(frames: object[]): Response {
	const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function harness(streamRoute: StreamRoute) {
	const calls: string[] = [];
	const fetchImpl = (async (input: RequestInfo | URL) => {
		const url = String(input);
		const path = new URL(url).pathname;
		calls.push(path);
		if (path === "/api/conversations") {
			return Response.json({ id: `conv-${calls.length}` });
		}
		if (path === "/api/local-inference/voice-models") {
			return Response.json({ installations: [] });
		}
		if (path.endsWith("/messages/stream")) return streamRoute();
		if (path.endsWith("/messages")) {
			return Response.json({ id: "msg-1", text: "buffered reply" });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	const adapter = new RuntimeHttpVoiceAdapter({
		env: ENV,
		apiBase: "http://127.0.0.1:31337",
		fetchImpl,
	});
	const service = new VoiceService({ env: ENV, runtimeAdapter: adapter });
	const messagePosts = () =>
		calls.filter((path) => /\/messages(\/stream)?$/.test(path));
	return { service, calls, messagePosts };
}

describe("VoiceService streaming runtime handoff", () => {
	it("does not re-send the message when the stream fails after it was accepted", async () => {
		const { service, messagePosts } = harness(() =>
			sse([
				{ type: "token", text: "Hel", fullText: "Hel" },
				{ type: "error", message: "generation crashed" },
			]),
		);
		await service.start({ mode: "local-runtime" });

		await expect(
			service.injectTranscript({ text: "hello there", final: true }),
		).rejects.toThrow("generation crashed");
		expect(messagePosts()).toHaveLength(1);
		expect(messagePosts()[0]).toMatch(/\/messages\/stream$/);
	});

	it("does not re-send the message when the stream route fails with a server error", async () => {
		const { service, messagePosts } = harness(
			() => new Response("boom", { status: 500 }),
		);
		await service.start({ mode: "local-runtime" });

		await expect(
			service.injectTranscript({ text: "hello there", final: true }),
		).rejects.toBeInstanceOf(VoiceError);
		expect(messagePosts()).toHaveLength(1);
	});

	it("falls back to the buffered route only when the stream route is not served", async () => {
		const { service, messagePosts } = harness(
			() => new Response("not found", { status: 404 }),
		);
		await service.start({ mode: "local-runtime" });

		const turn = await service.injectTranscript({
			text: "hello there",
			final: true,
		});
		expect(messagePosts()).toHaveLength(2);
		expect(messagePosts()[1]).toMatch(/\/messages$/);
		expect(turn.responseText).toBe("buffered reply");
	});
});
