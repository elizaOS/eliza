/**
 * Pins the scope-disclosure contract of the two read-only triage actions:
 * listInbox and searchMessages must name what narrowed their result (requested
 * sources against the registered ones, time window, limit) instead of asserting
 * full coverage of "connected platforms"/"connected channels". Deterministic —
 * a real TriageService with a locally registered stub adapter, the in-process
 * message-ref store, and the fake runtime; no live model, connector, or DB.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IAgentRuntime } from "../../../../types/index.ts";
import { listInboxAction } from "../actions/listInbox.ts";
import { searchMessagesAction } from "../actions/searchMessages.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
	__resetDefaultMessageRefStoreForTests,
	getDefaultMessageRefStore,
} from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type { ListOptions, MessageRef, MessageSource } from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

function messageRef(overrides: Partial<MessageRef>): MessageRef {
	return {
		id: "msg",
		source: "discord",
		externalId: "external-msg",
		from: { identifier: "alice@example.com" },
		to: [{ identifier: "owner@example.com" }],
		snippet: "hello",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

/** Stands in for a connector plugin's adapter: available, list-backed. */
class StubDiscordAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("discord") != null;
	}

	protected async listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return [
			messageRef({ id: "discord-1", externalId: "1", receivedAtMs: 2_000 }),
			messageRef({ id: "discord-2", externalId: "2", receivedAtMs: 1_000 }),
		];
	}
}

/** A second connector, so "all connected sources" has something to be wrong about. */
class StubGmailAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "gmail";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("gmail") != null;
	}

	protected async listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return [
			messageRef({
				id: "gmail-1",
				externalId: "g1",
				source: "gmail",
				receivedAtMs: 3_000,
			}),
		];
	}
}

/** Available, but its read throws — the partial-degrade path. */
class ThrowingGmailAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "gmail";

	isAvailable(): boolean {
		return true;
	}

	protected async listMessagesImpl(): Promise<MessageRef[]> {
		throw new Error("gmail upstream 503");
	}
}

const runtimeWithDiscord = (): IAgentRuntime =>
	createFakeRuntime({ availableServices: new Set(["discord"]) });

describe("triage read actions disclose their scope", () => {
	beforeEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
		getDefaultTriageService().register(new StubDiscordAdapter());
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("names the source filter when a scoped inbox check comes back empty", async () => {
		// Unread mail exists — in a source the request filtered away.
		getDefaultMessageRefStore().saveMessages([
			messageRef({ id: "discord-1", externalId: "1" }),
		]);

		const result = await listInboxAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { sources: ["gmail"] } } as never,
		);

		expect(result.success).toBe(true);
		// The old text claimed the whole inbox across every connected platform.
		expect(result.text).not.toBe(
			"No unread messages across connected platforms.",
		);
		// gmail has no adapter registered here, so it was NOT checked. Naming it
		// as a searched source — "sources=gmail (1 of 1 connected)" — asserted a
		// sweep that never happened.
		expect(result.text).toContain("gmail not connected");
		expect(result.text).toContain("no source was successfully checked");
		expect(result.text).toContain("drop the filters");
	});

	it("names the limit and the shown count when unread messages are trimmed", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({ id: "discord-1", externalId: "1", receivedAtMs: 3_000 }),
			messageRef({ id: "discord-2", externalId: "2", receivedAtMs: 2_000 }),
		]);

		const result = await listInboxAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { sources: ["discord"], limit: 1 } } as never,
		);

		expect(result.data).toMatchObject({ total: 2, returned: 1 });
		expect(result.text).toContain("limit 1");
		expect(result.text).toContain("showing 1");
	});

	it("names the source and time filters when a search comes back empty", async () => {
		const result = await searchMessagesAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{
				parameters: { sources: ["gmail"], since: 5_000, content: "launch" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.text).not.toBe(
			"No matching messages found across connected channels.",
		);
		// Same as the inbox case: gmail is unregistered, so it was not searched.
		expect(result.text).toContain("gmail not connected");
		expect(result.text).toContain("a content keyword");
		expect(result.text).toContain("since ");
		// The keyword itself is named, never echoed.
		expect(result.text).not.toContain("launch");
	});

	it("distinguishes a truncated page from an exact fit by probing past the limit", async () => {
		// Two messages exist. limit=1 leaves one behind — real truncation, and
		// the text must say so definitively rather than hedge "more may match".
		const truncated = await searchMessagesAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { limit: 1 } } as never,
		);

		expect((truncated.data as { count: number }).count).toBe(1);
		expect(truncated.text).toContain("limit 1");
		expect(truncated.text).toContain("more matched beyond the 1-result limit");

		// limit=2 fits exactly. Inferring a cap from `hits.length >= limit`
		// would claim messages exist that do not — the exact-fit fabrication.
		const exact = await searchMessagesAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { limit: 2 } } as never,
		);

		expect((exact.data as { count: number }).count).toBe(2);
		expect(exact.text).not.toContain("more matched");
	});

	// A schema-valid number is not necessarily a representable instant. `1e100`
	// is finite, so it parsed cleanly and then threw RangeError the moment the
	// scope text formatted it — a crash introduced by describing the scope at
	// all. Rejected at the parse boundary now, so every consumer is safe.
	it("drops an out-of-range timestamp instead of crashing the render", async () => {
		const result = await searchMessagesAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { since: "1e100" } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.text).not.toContain("since ");
		expect(result.text).not.toContain("Invalid Date");
	});

	it("keeps a representable timestamp at the boundary", async () => {
		const result = await searchMessagesAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { since: 8.64e15 } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.text).toContain("since +275760-09-13T00:00:00.000Z");
	});

	// Coverage must be a measurement of what the read actually reached. These
	// four pin the ways a source can go unqueried while still being registered
	// — each previously rendered as "all N connected source(s)".
	describe("coverage is measured, never inferred from the registry", () => {
		it("says a cache-served inbox queried no source at all", async () => {
			// Two adapters registered, but a cached discord row short-circuits the
			// sweep: nothing is queried, so claiming the connected sources were
			// checked would be false.
			getDefaultTriageService().register(new StubGmailAdapter());
			getDefaultMessageRefStore().saveMessages([
				messageRef({ id: "discord-1", externalId: "1" }),
			]);

			const result = await listInboxAction.handler(
				runtimeWithDiscord(),
				messageRef({ id: "turn" }) as never,
				undefined,
				{ parameters: {} } as never,
			);

			expect(result.success).toBe(true);
			expect(result.text).toContain("from cached messages only");
			expect(result.text).toContain("no source was queried");
			expect(result.text).not.toContain("all 2 connected source(s)");
		});

		it("reports a registered-but-unavailable source as not checked", async () => {
			getDefaultTriageService().register(new StubGmailAdapter());
			// The runtime offers discord only, so the gmail adapter reports itself
			// unavailable and search skips it without error.
			const result = await searchMessagesAction.handler(
				runtimeWithDiscord(),
				messageRef({ id: "turn" }) as never,
				undefined,
				{ parameters: { content: "launch" } } as never,
			);

			expect(result.success).toBe(true);
			expect(result.text).toContain("gmail unavailable");
			expect(result.text).toContain("checked=discord");
			expect(result.text).not.toContain("all 2 connected source(s)");
		});

		it("reports a throwing source as failed while keeping the partial result", async () => {
			getDefaultTriageService().register(new ThrowingGmailAdapter());

			const result = await searchMessagesAction.handler(
				createFakeRuntime({
					availableServices: new Set(["discord", "gmail"]),
				}),
				messageRef({ id: "turn" }) as never,
				undefined,
				{ parameters: {} } as never,
			);

			expect(result.success).toBe(true);
			// The discord hits still come back — a partial sweep is useful — but it
			// must not read as a complete one.
			expect(result.text).toContain("gmail failed");
			expect(result.text).toContain("checked=discord");
			expect(result.text).not.toContain("all 2 connected source(s)");
		});

		it("still says all connected sources when every one succeeded", async () => {
			getDefaultTriageService().register(new StubGmailAdapter());

			const result = await searchMessagesAction.handler(
				createFakeRuntime({
					availableServices: new Set(["discord", "gmail"]),
				}),
				messageRef({ id: "turn" }) as never,
				undefined,
				{ parameters: {} } as never,
			);

			expect(result.success).toBe(true);
			expect(result.text).toContain("all 2 connected source(s)");
			expect(result.text).not.toContain("NOT checked");
		});
	});
});
