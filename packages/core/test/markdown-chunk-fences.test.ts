import { chunkMarkdownText } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function fenceBlocks(chunk: string): string[][] {
	const blocks: string[][] = [];
	let open: { char: string; length: number; lines: string[] } | undefined;
	for (const line of chunk.split("\n")) {
		const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (!match) {
			open?.lines.push(line);
			continue;
		}
		const marker = match[1];
		if (!open) {
			open = { char: marker[0], length: marker.length, lines: [] };
		} else if (
			marker[0] === open.char &&
			marker.length >= open.length &&
			/^[ \t]*$/.test(match[2])
		) {
			blocks.push(open.lines);
			open = undefined;
		} else {
			open.lines.push(line);
		}
	}
	expect(open, `unclosed fence in ${JSON.stringify(chunk)}`).toBeUndefined();
	return blocks;
}

describe("chunkMarkdownText fence splitting", () => {
	it.each(
		["```", "``` ", "```\t", "````", "  ```", "``````   "].flatMap((closer) => [
			[closer, "\n"],
			[closer, "\n\n"],
		]),
	)(
		"never emits an empty code block when the closing line is %j after %j",
		(closer, beforeCloser) => {
			const body = Array.from(
				{ length: 10 },
				(_, i) => `line ${i} value${"x".repeat(i % 4)}`,
			);
			const text = `Intro.\n\n\`\`\`ts\n${body.join("\n")}${beforeCloser}${closer}\n\nOutro paragraph.`;
			for (let limit = 16; limit <= 110; limit++) {
				const chunks = chunkMarkdownText(text, limit);
				const codeLines: string[] = [];
				for (const chunk of chunks) {
					expect(chunk.length).toBeLessThanOrEqual(limit);
					for (const block of fenceBlocks(chunk)) {
						expect(
							block.join("").trim(),
							`limit ${limit}: ${JSON.stringify(chunk)}`,
						).not.toBe("");
						codeLines.push(...block);
					}
				}
				expect(codeLines.join("").replace(/\s+/g, "")).toBe(
					body.join("").replace(/\s+/g, ""),
				);
				expect(chunks.at(-1)).toContain("Outro paragraph.");
			}
		},
	);
});
