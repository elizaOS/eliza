/**
 * Error-message integrity for embedding-server HTTP failures.
 *
 * byt61 #24906 (surrogate-safe error truncation): remote error bodies were
 * previously sliced with `body.slice(0, 200)`, which can cut a UTF-16
 * surrogate pair in half and leave a dangling half-surrogate inside the
 * thrown message. Downstream consumers (loggers, JSON serialization) then
 * emit malformed text or fail. The fix routes the body through
 * `truncateWellFormed(toWellFormedUnicode(body), 200)` from @elizaos/core:
 * lone surrogates are replaced with U+FFFD, and a cut that would land on
 * the lead half of a pair backs off so the pair is kept whole or dropped
 * whole. These tests pin that contract on the thrown message.
 */
import { describe, expect, it } from "vitest";
import { embedWithFetch } from "./embedding-server";

const BASE_URL = "http://127.0.0.1:9";
const ERROR_PREFIX = "[embedding-server] /v1/embeddings returned 502: ";

function errorResponse(body: string, status = 502): typeof fetch {
	return (async () =>
		new Response(body, {
			status,
			statusText: "Bad Gateway",
		})) as typeof fetch;
}

describe("embedding-server error message integrity", () => {
	it("prefixes the provider status and keeps the body verbatim", async () => {
		await expect(
			embedWithFetch(BASE_URL, ["hello"], 64, errorResponse("busy"), 1_000),
		).rejects.toThrow(`${ERROR_PREFIX}busy`);
	});

	it("drops a surrogate pair whole instead of leaving a dangling lead", async () => {
		// Pair straddles the 200-code-unit cut (index 199 is the high
		// surrogate): raw `slice(0, 200)` would keep \uD83D alone. The
		// well-formed truncation backs off and drops the pair entirely.
		const body = `${"e".repeat(199)}😀${"x".repeat(50)}`;
		const error = await embedWithFetch(
			BASE_URL,
			["hello"],
			64,
			errorResponse(body),
			1_000,
		).catch((cause: unknown) => cause as Error);
		const content = error.message.slice(ERROR_PREFIX.length);
		expect(content).toBe("e".repeat(199));
		expect(content.isWellFormed()).toBe(true);
		expect(content.length).toBe(199);
		expect(content).not.toContain("\uD83D");
	});

	it("keeps a surrogate pair whole when it fits inside the boundary", async () => {
		// Pair ends exactly at the 200-code-unit cut: truncation keeps it.
		const body = `${"e".repeat(198)}😀z`;
		const error = await embedWithFetch(
			BASE_URL,
			["hello"],
			64,
			errorResponse(body),
			1_000,
		).catch((cause: unknown) => cause as Error);
		const content = error.message.slice(ERROR_PREFIX.length);
		expect(content).toBe(`${"e".repeat(198)}😀`);
		expect(content.isWellFormed()).toBe(true);
		expect(content.length).toBe(200);
		expect(content).toContain("😀");
	});

	it("replaces lone surrogates in the error body with U+FFFD", async () => {
		const body = "a\uD800b\uDC00c";
		const error = await embedWithFetch(
			BASE_URL,
			["hello"],
			64,
			errorResponse(body),
			1_000,
		).catch((cause: unknown) => cause as Error);
		const message = error.message;
		expect(message.isWellFormed()).toBe(true);
		expect(message).not.toContain("\uD800");
		expect(message).not.toContain("\uDC00");
		expect(message).toContain("\uFFFD");
	});

	it("keeps multi-code-point bodies intact below the boundary", async () => {
		const body = "😀".repeat(5);
		const error = await embedWithFetch(
			BASE_URL,
			["hello"],
			64,
			errorResponse(body),
			1_000,
		).catch((cause: unknown) => cause as Error);
		expect(error.message).toBe(`${ERROR_PREFIX}${"😀".repeat(5)}`);
	});
});
