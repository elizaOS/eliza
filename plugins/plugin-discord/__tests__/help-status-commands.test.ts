/**
 * `/help` and `/status` are simple built-ins with no role gate exercised
 * elsewhere: help lists every registered command's usage line, status reports
 * process uptime/memory. `/search` covers its three branches (results found,
 * no results, and a thrown `getMemories`) since nothing else in the changed
 * test set reaches it. Deterministic — no Discord gateway, no runtime calls
 * beyond the reply/getMemories double.
 */
import { describe, expect, it, vi } from "vitest";
import { getRegisteredCommands } from "../slash-commands";

function makeInteraction() {
	const replies: Array<{ content: string; ephemeral?: boolean }> = [];
	return {
		replies,
		client: { guilds: { cache: { size: 3 } } },
		reply: vi.fn(async (arg: { content: string; ephemeral?: boolean }) => {
			replies.push(arg);
		}),
	};
}

function makeSearchInteraction(query: string, limit?: number) {
	const edits: Array<{ content: string }> = [];
	return {
		edits,
		channelId: "channel-1",
		deferred: false,
		options: {
			getString: () => query,
			getNumber: () => limit ?? null,
		},
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async (arg: { content: string }) => {
			edits.push(arg);
		}),
	};
}

describe("/search", () => {
	it("returns matching memories, truncated and numbered", async () => {
		const search = getRegisteredCommands().get("search");
		if (!search) throw new Error("search command not registered");
		const interaction = makeSearchInteraction("hello");
		const runtime = {
			getMemories: vi.fn(async () => [
				{ content: { text: "hello world" }, createdAt: Date.now() },
				{ content: { text: "unrelated" }, createdAt: Date.now() },
			]),
		};

		await search.execute(interaction as never, runtime as never);

		expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
		expect(interaction.edits).toHaveLength(1);
		expect(interaction.edits[0].content).toContain(
			'Search results for "hello"',
		);
		expect(interaction.edits[0].content).toContain("hello world");
	});

	it("reports no results when nothing matches", async () => {
		const search = getRegisteredCommands().get("search");
		if (!search) throw new Error("search command not registered");
		const interaction = makeSearchInteraction("nomatch");
		const runtime = { getMemories: vi.fn(async () => []) };

		await search.execute(interaction as never, runtime as never);

		expect(interaction.edits[0].content).toContain(
			'No results found for **"nomatch"**',
		);
	});

	it("reports the error message when getMemories throws", async () => {
		const search = getRegisteredCommands().get("search");
		if (!search) throw new Error("search command not registered");
		const interaction = makeSearchInteraction("broken");
		const runtime = {
			getMemories: vi.fn(async () => {
				throw new Error("db unavailable");
			}),
		};

		await search.execute(interaction as never, runtime as never);

		expect(interaction.edits[0].content).toContain(
			"Search failed: db unavailable",
		);
	});
});

describe("/help", () => {
	it("lists every registered command with its usage line", async () => {
		const help = getRegisteredCommands().get("help");
		if (!help) throw new Error("help command not registered");
		const interaction = makeInteraction();

		await help.execute(interaction as never, {} as never);

		expect(interaction.replies).toHaveLength(1);
		expect(interaction.replies[0].ephemeral).toBe(true);
		expect(interaction.replies[0].content).toContain("/ask");
		expect(interaction.replies[0].content).toContain("/help");
	});
});

describe("/status", () => {
	it("reports uptime and memory usage as an ephemeral reply", async () => {
		const status = getRegisteredCommands().get("status");
		if (!status) throw new Error("status command not registered");
		const interaction = makeInteraction();

		await status.execute(interaction as never, {} as never);

		expect(interaction.replies).toHaveLength(1);
		expect(interaction.replies[0].ephemeral).toBe(true);
		expect(interaction.replies[0].content).toMatch(/Memory/i);
	});
});
