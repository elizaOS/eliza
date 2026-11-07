import { describe, expect, it } from "vitest";
import { chunkDiscordText } from "../messaging";
import { sendMessageInChunks } from "../utils";

describe("sendMessageInChunks", () => {
	it("keeps a code fence balanced in every chunk of a long channel reply", async () => {
		const code = Array.from(
			{ length: 60 },
			(_, i) => `const value_${i} = compute(${i}) * factor; // step ${i}`,
		).join("\n");
		const content = `Here is the script:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nRun it with **bun**.`;
		const sent: string[] = [];
		const channel = {
			send: async (options: { content: string }) => {
				sent.push(options.content);
				return { id: String(sent.length) };
			},
		};

		await sendMessageInChunks(channel as never, content, "", []);

		expect(sent.length).toBeGreaterThan(1);
		for (const chunk of sent) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
			expect(chunk.match(/```/g)?.length).toBe(2);
		}
	});
});

describe("chunkDiscordText CommonMark fence rules", () => {
	const prose = Array.from(
		{ length: 20 },
		(_, i) => `Plain sentence number ${i} about the reply.`,
	).join("\n");

	it("does not open a fence on a backtick line whose info has a backtick", () => {
		const text = `\`\`\`alpha\`beta\`\`\` is inline code.\n${prose}`;
		const chunks = chunkDiscordText(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("\n")).toBe(text);
	});

	it("does not close a fence on a backtick line with an info string", () => {
		const rows = Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n");
		const text = `\`\`\`md\n${rows}\n\`\`\`js\nstill code\n\`\`\`\nAfter the block.`;
		const chunks = chunkDiscordText(text);

		expect(chunks.length).toBeGreaterThan(1);
		const last = chunks.at(-1) ?? "";
		expect(last.endsWith("```\nAfter the block.")).toBe(true);
		for (const chunk of chunks) {
			expect(chunk.split("\n").filter((line) => line === "```").length).toBe(1);
		}
	});

	it("still closes a fence on a bare closing line with trailing spaces", () => {
		const rows = Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n");
		const text = `\`\`\`md\n${rows}\n\`\`\`  \nAfter the block.`;
		const chunks = chunkDiscordText(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.at(-1)?.endsWith("```  \nAfter the block.")).toBe(true);
	});
});
