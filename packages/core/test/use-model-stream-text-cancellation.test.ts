/** Cancellation after useModel returns must also reach its lazy text promise. */

import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { runWithStreamingContext } from "../src/streaming-context";
import { ModelType, type TextStreamResult } from "../src/types/model";

async function createTransport(complete: boolean, deferFinish = false) {
	const closed = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<string | undefined>();
	if (!deferFinish) finish.resolve("stop");
	const server = createServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/plain" });
		response.on("close", () => closed.resolve());
		if (complete) response.end("complete answer");
		else response.write("partial answer");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const runtime = createSQLiteTestRuntime({
		character: { name: "LazyTextCancellation", bio: "HTTP streaming contract" },
		logLevel: "fatal",
	});
	const observed = { calls: 0, fallbackCalls: 0 };
	let providerText: Promise<string> | undefined;
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params): Promise<TextStreamResult> => {
			observed.calls++;
			const response = await fetch(url, {
				signal: params.signal as AbortSignal,
			});
			const text = response.text();
			providerText = text;
			return {
				text,
				textStream: (async function* () {
					yield await text;
				})(),
				finishReason: finish.promise,
				usage: Promise.resolve(undefined),
			};
		},
		"http-stream",
		100,
	);
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async () => {
			observed.fallbackCalls++;
			return "unexpected fallback";
		},
		"backup",
		10,
	);
	return {
		runtime,
		observed,
		closed: closed.promise,
		finish: () => finish.resolve("stop"),
		get providerText() {
			if (!providerText) throw new Error("Provider has not dispatched");
			return providerText;
		},
		async close() {
			await providerText?.catch(() => undefined);
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			await runtime.stop();
		},
	};
}

describe("useModel pass-through text cancellation", () => {
	it.each(["caller", "turn"] as const)(
		"rejects completed text consumed after the %s cancels",
		async (owner) => {
			const transport = await createTransport(true);
			const caller = new AbortController();
			const turn = new AbortController();
			const reason = new Error(`${owner} cancelled before consuming text`);
			const params = { prompt: "hello", stream: true, signal: caller.signal };
			try {
				const stream = (await runWithStreamingContext(
					{ abortSignal: turn.signal },
					() => transport.runtime.useModel(ModelType.TEXT_LARGE, params),
				)) as TextStreamResult;
				expect(await transport.providerText).toBe("complete answer");
				(owner === "caller" ? caller : turn).abort(reason);
				await expect(stream.text).rejects.toBe(reason);
				expect(params.signal).toBe(caller.signal);
				expect(transport.observed).toEqual({ calls: 1, fallbackCalls: 0 });
			} finally {
				caller.abort();
				turn.abort();
				await transport.close();
			}
		},
	);

	it.each(["caller", "turn"] as const)(
		"preserves the %s cancellation reason while awaiting the HTTP response body",
		async (owner) => {
			const transport = await createTransport(false);
			const caller = new AbortController();
			const turn = new AbortController();
			const reason = new Error(`${owner} cancelled pending text`);
			try {
				const stream = (await runWithStreamingContext(
					{ abortSignal: turn.signal },
					() =>
						transport.runtime.useModel(ModelType.TEXT_LARGE, {
							prompt: "hello",
							stream: true,
							signal: caller.signal,
						}),
				)) as TextStreamResult;
				const result = stream.text.catch((error: unknown) => error);
				(owner === "caller" ? caller : turn).abort(reason);
				expect(await result).toBe(reason);
				await transport.closed;
				expect(transport.observed).toEqual({ calls: 1, fallbackCalls: 0 });
				expect((owner === "caller" ? turn : caller).signal.aborted).toBe(false);
			} finally {
				caller.abort();
				turn.abort();
				await transport.close();
			}
		},
	);

	it.each(["caller", "turn"] as const)(
		"rejects text when the %s cancels while finish metadata is pending",
		async (owner) => {
			const transport = await createTransport(true, true);
			const caller = new AbortController();
			const turn = new AbortController();
			const reason = new Error(`${owner} cancelled pending finish metadata`);
			try {
				const stream = (await runWithStreamingContext(
					{ abortSignal: turn.signal },
					() =>
						transport.runtime.useModel(ModelType.TEXT_LARGE, {
							prompt: "hello",
							stream: true,
							signal: caller.signal,
						}),
				)) as TextStreamResult;
				await transport.providerText;
				const result = stream.text.catch((error: unknown) => error);
				// Let the text getter advance to its pending finish-reason await.
				await Promise.resolve();
				(owner === "caller" ? caller : turn).abort(reason);
				transport.finish();
				expect(await result).toBe(reason);
				expect(transport.observed).toEqual({ calls: 1, fallbackCalls: 0 });
			} finally {
				transport.finish();
				caller.abort();
				turn.abort();
				await transport.close();
			}
		},
	);

	it("retains successful text, finish reason and the iterable without cancellation", async () => {
		const transport = await createTransport(true);
		try {
			const stream = (await transport.runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "hello",
				stream: true,
			})) as TextStreamResult;
			expect(await stream.text).toBe("complete answer");
			expect(await stream.finishReason).toBe("stop");
			const chunks: string[] = [];
			for await (const chunk of stream.textStream) chunks.push(chunk);
			expect(chunks.join("")).toBe("complete answer");
			expect(transport.observed).toEqual({ calls: 1, fallbackCalls: 0 });
		} finally {
			await transport.close();
		}
	});
});
