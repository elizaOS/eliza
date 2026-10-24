import { describe, expect, it, vi } from "vitest";
import { deliverInteractionReply } from "../discord-interactions";

const runtime = {
	agentId: "agent-1",
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
	getSetting: () => undefined,
} as never;

describe("button reply fallback", () => {
	it("sends only the chunks the interaction did not deliver", async () => {
		const first = `${"a".repeat(1500)}\n`;
		const second = "b".repeat(1500);
		const followed: string[] = [];
		const sent: string[] = [];
		const interaction = {
			customId: "button-1",
			followUp: vi.fn(async ({ content }: { content: string }) => {
				// The interaction token expires after the first chunk.
				if (followed.length === 1) throw new Error("Unknown Webhook");
				followed.push(content);
				return {};
			}),
			channel: {
				send: vi.fn(async (options: { content?: string } | string) => {
					sent.push(
						typeof options === "string" ? options : (options.content ?? ""),
					);
					return { id: `m${sent.length}` };
				}),
			},
		};

		await deliverInteractionReply(
			interaction,
			{ text: first + second, components: [] },
			runtime,
		);

		expect(followed).toHaveLength(1);
		expect(followed[0]).toContain("aaa");
		// Nothing the user already got is sent again.
		expect(sent.join("")).not.toContain("aaa");
		expect(sent.join("")).toContain("bbb");
	});
});
