/**
 * `/help` and `/status` are simple built-ins with no role gate exercised
 * elsewhere: help lists every registered command's usage line, status reports
 * process uptime/memory. Deterministic — no Discord gateway, no runtime calls
 * beyond the reply.
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
