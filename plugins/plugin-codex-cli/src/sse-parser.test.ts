/**
 * Deterministic unit test for parseSSE (plugin-codex-cli): the spec-compliant
 * SSE parser for ChatGPT Codex response streams. Exercises chunked CRLF/CR/LF
 * framing, comment lines, multi-line data join semantics, the retry field's
 * strict integer gate, and EOF tail handling for buffered partial lines.
 * Pure-function test — no runtime.
 */
import { describe, expect, it } from "vitest";
import { parseSSE } from "./sse-parser.ts";

/** Collect all events from an SSE stream body. */
async function collect(body: string | Uint8Array): Promise<ReturnType<typeof collect>> {
	const encoder = new TextEncoder();
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	const events: Array<Record<string, unknown>> = [];
	for await (const event of parseSSE(stream)) {
		events.push({ ...event });
	}
	return events as never;
}

/** Feed a string split at every possible chunk boundary, one byte per chunk. */
async function collectBytewise(body: string): Promise<ReturnType<typeof collect>> {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(body);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
			controller.close();
		},
	});
	const events: Array<Record<string, unknown>> = [];
	for await (const event of parseSSE(stream)) {
		events.push({ ...event });
	}
	return events as never;
}

describe("parseSSE — framing and field semantics", () => {
	it("parses a single data event terminated by LF", async () => {
		const events = await collect("data: hello\n\n");
		expect(events).toEqual([{ data: "hello" }]);
	});

	it("parses events separated by CRLF line endings", async () => {
		const events = await collect("data: one\r\n\r\ndata: two\r\n\r\n");
		expect(events).toEqual([{ data: "one" }, { data: "two" }]);
	});

	it("parses events separated by bare CR line endings", async () => {
		const events = await collect("data: one\r\rdata: two\r\r");
		expect(events).toEqual([{ data: "one" }, { data: "two" }]);
	});

	it("joins multi-line data fields with a newline", async () => {
		const events = await collect("data: line1\ndata: line2\n\n");
		expect(events).toEqual([{ data: "line1\nline2" }]);
	});

	it("skips comment lines starting with a colon", async () => {
		const events = await collect(": keep-alive\ndata: payload\n\n");
		expect(events).toEqual([{ data: "payload" }]);
	});

	it("strips exactly one leading space from a field value", async () => {
		const events = await collect("data:  padded\n\n");
		expect(events).toEqual([{ data: " padded" }]);
	});

	it("treats a colon-less line as a field name with an empty value", async () => {
		const events = await collect("data\n\ndata: x\n\n");
		expect(events).toEqual([{ data: "" }, { data: "x" }]);
	});

	it("captures the event name and id fields", async () => {
		const events = await collect("event: delta\nid: 42\ndata: patch\n\n");
		expect(events).toEqual([{ event: "delta", id: "42", data: "patch" }]);
	});
});

describe("parseSSE — retry field strictness", () => {
	it("parses a valid integer retry value", async () => {
		const events = await collect("retry: 500\n\n");
		expect(events).toEqual([{ data: "", retry: 500 }]);
	});

	it("rejects non-finite retry values", async () => {
		const events = await collect("retry: NaN\n\n");
		expect(events).toEqual([]);
	});

	it("ignores an unknown field name", async () => {
		const events = await collect("bogus: 1\ndata: ok\n\n");
		expect(events).toEqual([{ data: "ok" }]);
	});
});

describe("parseSSE — chunk-boundary robustness", () => {
	it("produces identical events when fed one byte at a time", async () => {
		const whole = await collect("event: msg\ndata: a\n\ndata: b\ndata: c\n\n");
		const bytewise = await collectBytewise("event: msg\ndata: a\n\ndata: b\ndata: c\n\n");
		expect(bytewise).toEqual(whole);
	});

	it("handles a split CRLF pair across chunk boundaries", async () => {
		const events = await collectBytewise("data: x\r\n\r\n");
		expect(events).toEqual([{ data: "x" }]);
	});
});

describe("parseSSE — EOF tail handling", () => {
	it("emits a buffered event whose final line has no trailing newline", async () => {
		const events = await collect("data: tail");
		expect(events).toEqual([{ data: "tail" }]);
	});

	it("emits an event at EOF after a blank line with no trailing newline", async () => {
		const events = await collect("data: head\n\n");
		expect(events).toEqual([{ data: "head" }]);
	});

	it("parses a retry field in the EOF tail (no trailing newline)", async () => {
		const events = await collect("data: done\nretry: 900");
		expect(events).toEqual([{ data: "done", retry: 900 }]);
	});

	it("parses an event field in the EOF tail (no trailing newline)", async () => {
		const events = await collect("data: done\nevent: complete");
		expect(events).toEqual([{ data: "done", event: "complete" }]);
	});
});
