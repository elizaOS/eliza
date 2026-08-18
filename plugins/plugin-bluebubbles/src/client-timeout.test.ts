/**
 * Exercises BlueBubbles JSON and attachment deadlines through the public
 * client with deterministic fetch and abort signals; no live bridge calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlueBubblesClient } from "./client.js";

function client(): BlueBubblesClient {
	return new BlueBubblesClient({
		serverUrl: "http://127.0.0.1:9",
		password: "pw",
	});
}

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected BlueBubbles abort signal");
			const onAbort = () => reject(signal.reason);
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
		})) as typeof fetch;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("BlueBubbles client request deadlines", () => {
	it("aborts a stalled JSON request at the client deadline", async () => {
		const controller = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		vi.stubGlobal("fetch", stallUntilAborted());

		const pending = client().sendMessage("iMessage;-;+14155550100", "hi");
		controller.abort(new DOMException("deadline", "TimeoutError"));

		await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
		expect(timeout).toHaveBeenCalledWith(15_000);
	});

	it("composes the probe cancellation signal with the client deadline", async () => {
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		vi.stubGlobal("fetch", stallUntilAborted());

		const pending = client().probe(5_000);
		timeoutController.abort(new DOMException("deadline", "TimeoutError"));

		await expect(pending).resolves.toMatchObject({
			ok: false,
			error: "deadline",
		});
	});

	it("honors the probe caller deadline even when the client deadline is open", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(
			new AbortController().signal,
		);
		vi.stubGlobal("fetch", stallUntilAborted());

		await expect(client().probe(5)).resolves.toMatchObject({ ok: false });
	});

	it("keeps the attachment response body inside the upload deadline", async () => {
		const controller = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		let bodyStarted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const signal = init?.signal;
				if (!signal) throw new Error("expected attachment abort signal");
				return new Response(
					new ReadableStream({
						start(stream) {
							bodyStarted = true;
							signal.addEventListener(
								"abort",
								() => stream.error(signal.reason),
								{
									once: true,
								},
							);
						},
					}),
				);
			}),
		);

		const pending = client().sendAttachmentBuffer(
			"iMessage;-;+14155550100",
			new Uint8Array([1, 2, 3]),
			"photo.jpg",
			"image/jpeg",
		);
		await vi.waitFor(() => expect(bodyStarted).toBe(true));
		controller.abort(new DOMException("deadline", "TimeoutError"));

		await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
		expect(timeout).toHaveBeenCalledWith(30_000);
	});

	it("preserves provider errors and successful message payloads", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
			.mockResolvedValueOnce(
				Response.json({ data: { guid: "msg-1", dateCreated: 1, text: "hi" } }),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			client().sendMessage("iMessage;-;+14155550100", "hi"),
		).rejects.toThrow("BlueBubbles API error (401)");
		await expect(
			client().sendMessage("iMessage;-;+14155550100", "hi"),
		).resolves.toMatchObject({ guid: "msg-1", status: "sent" });
	});
});
