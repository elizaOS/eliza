import { describe, expect, it } from "vitest";
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
