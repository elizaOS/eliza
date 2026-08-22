/**
 * #10471 — POST op routing must come from the planner-emitted `action` enum
 * (or structured query/feed params), never from English keywords in the user
 * text. Keyword routing (e.g. `/\b(search|find)\b/`) silently fails for every
 * non-English request, so op selection stays structured-only.
 */

import { describe, expect, it, vi } from "vitest";
import type { Content, IAgentRuntime, Memory } from "../../../types/index.ts";
import { postAction, resolveOp } from "./post.ts";

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
		// says, in any language. The op never comes from natural-language
		// keywords.
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

describe("POST trusted connector account routing", () => {
	it("passes the envelope account to an internal dispatcher and ignores Content spoofing", async () => {
		let routedAccountId: string | undefined;
		let sentContent: Content | undefined;
		const upsertMemory = vi.fn(async () => undefined);
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getPostConnectors: () => [
				{
					source: "x",
					label: "X",
					accountRouting: "connector",
					capabilities: ["post"],
					contexts: [],
					postHandler: async (
						_runtime: IAgentRuntime,
						content: Content,
						context?: { accountId?: string },
					) => {
						sentContent = content;
						routedAccountId = context?.accountId;
						return undefined;
					},
				},
			],
			upsertMemory,
		} as unknown as IAgentRuntime;
		const message = {
			id: "00000000-0000-0000-0000-0000000000aa",
			roomId: "00000000-0000-0000-0000-0000000000bb",
			entityId: "00000000-0000-0000-0000-0000000000cc",
			agentId: "00000000-0000-0000-0000-000000000001",
			metadata: { type: "message", source: "x", accountId: "secondary" },
			content: {
				text: "publish this",
				source: "untrusted-source",
				metadata: { accountId: "primary" },
			},
			createdAt: 1,
		} as Memory;

		const result = await postAction.handler(
			runtime,
			message,
			undefined,
			{
				parameters: {
					action: "send",
					text: "publish this",
					persist: false,
				},
			},
			undefined,
			undefined,
		);

		expect(result?.success).toBe(true);
		expect(routedAccountId).toBe("secondary");
		expect(sentContent?.source).toBe("x");
		expect(sentContent?.metadata).toMatchObject({ accountId: "secondary" });
		expect(message.content.metadata).toEqual({ accountId: "primary" });
		expect(upsertMemory).toHaveBeenCalledOnce();
	});

	it("fails closed when another account's display label collides with the trusted account id", async () => {
		const postHandler = vi.fn(async () => undefined);
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getPostConnectors: () => [
				{
					source: "x",
					label: "X other account",
					accountId: "other",
					account: { accountId: "other", label: "original" },
					capabilities: ["post"],
					contexts: [],
					postHandler,
				},
			],
		} as unknown as IAgentRuntime;
		const inbound = {
			id: "00000000-0000-0000-0000-0000000000aa",
			roomId: "00000000-0000-0000-0000-0000000000bb",
			entityId: "00000000-0000-0000-0000-0000000000cc",
			agentId: "00000000-0000-0000-0000-000000000001",
			metadata: { type: "message", source: "x", accountId: "original" },
			content: { text: "publish this", source: "x" },
			createdAt: 1,
		} as Memory;

		const result = await postAction.handler(
			runtime,
			inbound,
			undefined,
			{
				parameters: {
					action: "send",
					text: "publish this",
					persist: false,
				},
			},
			undefined,
			undefined,
		);

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			error: "ACCOUNT_CONNECTOR_NOT_FOUND",
			accountId: "original",
		});
		expect(postHandler).not.toHaveBeenCalled();
	});

	it("rejects an overlong post without truncating or dispatching it", async () => {
		const postHandler = vi.fn(async () => undefined);
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getPostConnectors: () => [
				{
					source: "bounded",
					label: "Bounded feed",
					capabilities: ["post"],
					contexts: [],
					contentShaping: { constraints: { maxLength: 12 } },
					postHandler,
				},
			],
		} as unknown as IAgentRuntime;
		const message = {
			id: "00000000-0000-0000-0000-0000000000aa",
			roomId: "00000000-0000-0000-0000-0000000000bb",
			entityId: "00000000-0000-0000-0000-0000000000cc",
			agentId: runtime.agentId,
			content: { text: "complete post with a required tail" },
			createdAt: 1,
		} as Memory;

		const result = await postAction.handler(runtime, message, undefined, {
			parameters: {
				action: "send",
				text: "complete post with a required tail",
			},
		});

		expect(result).toMatchObject({
			success: false,
			data: {
				error: "POST_CONTENT_TOO_LONG",
				maxLength: 12,
				actualLength: 34,
			},
		});
		expect(postHandler).not.toHaveBeenCalled();
	});
});
