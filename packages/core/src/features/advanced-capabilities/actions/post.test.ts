import { describe, expect, it } from "vitest";
import { postAction, resolveOp } from "./post.ts";

/**
 * #10471 — POST op routing must come from the planner-emitted `action` enum
 * (or structured query/feed params), never from English keywords in the user
 * text. These cases previously routed via `/\b(search|find)\b/` etc., which
 * silently failed for every non-English request.
 */
describe("post resolveOp is i18n-safe (#10471)", () => {
	it("routes by the planner action enum", () => {
		expect(resolveOp({ parameters: { action: "search" } })).toBe("search");
		expect(resolveOp({ parameters: { action: "read" } })).toBe("read");
		expect(resolveOp({ parameters: { action: "send" } })).toBe("send");
	});

	it("accepts enum aliases (publish/read_feed/search_posts)", () => {
		expect(resolveOp({ parameters: { action: "publish" } })).toBe("send");
		expect(resolveOp({ parameters: { action: "read_feed" } })).toBe("read");
		expect(resolveOp({ parameters: { action: "search_posts" } })).toBe(
			"search",
		);
	});

	it("falls back to structured query/feed signals, not text", () => {
		expect(resolveOp({ parameters: { query: "vitalik" } })).toBe("search");
		expect(resolveOp({ parameters: { feed: true } })).toBe("read");
	});

	it("does NOT infer the op from natural-language text", () => {
		// No structured params: defaults to send regardless of what the text
		// says, in any language. The old English regex would have returned
		// "search"/"read" here; that English-only behavior is gone.
		expect(resolveOp({ parameters: {} })).toBe("send");
		expect(resolveOp(undefined)).toBe("send");
	});
});

describe("POST routing hint (#12209)", () => {
	it("states its planner boundary versus MESSAGE, REPLY, and ROOM", () => {
		const hint = postAction.routingHint ?? "";
		expect(hint).toContain("POST");
		expect(hint).toContain("MESSAGE");
		expect(hint).toContain("REPLY");
		expect(hint).toContain("ROOM");
	});
});
