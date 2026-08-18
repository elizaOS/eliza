/**
 * Behavioral BlueBubbles client deadlines. Executes JSON request and
 * attachment POSTs under abort — not a source-grep of client.ts.
 */
import { describe, expect, it } from "vitest";
import {
	BLUEBUBBLES_ATTACHMENT_TIMEOUT_MS,
	BLUEBUBBLES_REQUEST_TIMEOUT_MS,
	blueBubblesRequestWithFetch,
	blueBubblesSendAttachmentWithFetch,
} from "./client.js";

const REQUEST_URL = "http://127.0.0.1:9/api/v1/message/text?password=pw";
const ATTACH_URL = "http://127.0.0.1:9/api/v1/message/attachment?password=pw";

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected bluebubbles abort signal");
			const onAbort = () => reject(signal.reason);
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		})) as typeof fetch;
}

describe("BlueBubbles client request deadlines", () => {
	it("keeps documented JSON and attachment budgets", () => {
		expect(BLUEBUBBLES_REQUEST_TIMEOUT_MS).toBe(15_000);
		expect(BLUEBUBBLES_ATTACHMENT_TIMEOUT_MS).toBe(30_000);
	});

	it("aborts a stalled JSON request at the injected deadline", async () => {
		await expect(
			blueBubblesRequestWithFetch(REQUEST_URL, {}, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed JSON request", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("unauthorized", {
				status: 401,
				statusText: "Unauthorized",
			});

		await expect(
			blueBubblesRequestWithFetch(REQUEST_URL, {}, fetchImpl, 1_000),
		).rejects.toThrow("401");
	});

	it("uses the injected fetch for a successful JSON request", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return Response.json({ data: { guid: "msg-1", text: "hi" } });
		};

		const payload = await blueBubblesRequestWithFetch<{
			data: { guid: string; text: string };
		}>(REQUEST_URL, { method: "POST" }, fetchImpl, 1_000);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(payload.data.guid).toBe("msg-1");
	});

	it("preserves a caller-supplied cancellation signal", async () => {
		const controller = new AbortController();
		const fetchImpl: typeof fetch = async (_input, init) => {
			expect(init?.signal).toBe(controller.signal);
			return Response.json({ data: { guid: "caller" } });
		};

		await blueBubblesRequestWithFetch(
			REQUEST_URL,
			{ signal: controller.signal },
			fetchImpl,
			10,
		);
	});

	it("honors caller abort without waiting for the request deadline", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			blueBubblesRequestWithFetch(
				REQUEST_URL,
				{ signal: controller.signal },
				stallUntilAborted(),
				5_000,
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("aborts a stalled attachment POST at the injected deadline", async () => {
		await expect(
			blueBubblesSendAttachmentWithFetch(
				ATTACH_URL,
				new FormData(),
				stallUntilAborted(),
				10,
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed attachment POST", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("too large", {
				status: 413,
				statusText: "Payload Too Large",
			});

		await expect(
			blueBubblesSendAttachmentWithFetch(
				ATTACH_URL,
				new FormData(),
				fetchImpl,
				1_000,
			),
		).rejects.toThrow("Failed to send attachment");
	});

	it("uses the injected fetch for a successful attachment POST", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return Response.json({
				data: { guid: "att-1", dateCreated: 1, text: "file" },
			});
		};

		const result = await blueBubblesSendAttachmentWithFetch(
			ATTACH_URL,
			new FormData(),
			fetchImpl,
			1_000,
		);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(result.data.guid).toBe("att-1");
	});
});
