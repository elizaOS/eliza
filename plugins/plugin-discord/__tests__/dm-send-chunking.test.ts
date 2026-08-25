/**
 * Discord DM replies must honor the platform's 2000-char message cap by
 * chunking, exactly like guild sends do via `sendMessageInChunks`. Before
 * this seam existed the DM path handed the full text to a single
 * `user.send(...)`, so a long reply (e.g. a multi-day recall digest) was
 * rejected by Discord and never delivered.
 *
 * Covers `sendDmInChunks`: budget enforcement, ordering, code-fence
 * integrity across chunk boundaries, single-send passthrough for short
 * messages, and last-chunk placement of files/components.
 */
import type { Message as DiscordMessage } from "discord.js";
import { describe, expect, it } from "vitest";
import type { DmSendOptions, DmSendTarget } from "../messages";
import { sendDmInChunks } from "../messages";
import { MAX_MESSAGE_LENGTH } from "../utils";

const DISCORD_HARD_LIMIT = 2000;

function makeRecordingUser(): {
	user: DmSendTarget;
	sends: DmSendOptions[];
} {
	const sends: DmSendOptions[] = [];
	const user: DmSendTarget = {
		send: async (options: DmSendOptions) => {
			sends.push(options);
			return {
				id: `msg-${sends.length}`,
				content: options.content,
			} as unknown as DiscordMessage;
		},
	};
	return { user, sends };
}

describe("sendDmInChunks transport budget", () => {
	it("splits a >2000-char plain message into ordered chunks each within budget", async () => {
		const paragraphs: string[] = [];
		for (let i = 0; i < 60; i++) {
			paragraphs.push(
				`Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(4)}`,
			);
		}
		const content = paragraphs.join("\n");
		expect(content.length).toBeGreaterThan(DISCORD_HARD_LIMIT);

		const { user, sends } = makeRecordingUser();
		const messages = await sendDmInChunks(user, content, [], undefined);

		expect(sends.length).toBeGreaterThan(1);
		expect(messages.length).toBe(sends.length);
		for (const options of sends) {
			expect(options.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
			expect(options.content.length).toBeLessThanOrEqual(DISCORD_HARD_LIMIT);
		}

		// Ordering: chunk order matches source order (compare a normalized
		// reassembly, since the chunker trims boundary whitespace).
		const rejoined = sends.map((s) => s.content).join("\n");
		const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
		expect(normalize(rejoined)).toBe(normalize(content));
	});

	it("keeps code fences valid in every chunk when a fence spans the boundary", async () => {
		const fenceBody = Array.from(
			{ length: 200 },
			(_, i) => `const line${i} = ${i}; // some code inside the fence`,
		).join("\n");
		const content = `Here is the diff:\n\`\`\`ts\n${fenceBody}\n\`\`\`\ndone.`;
		expect(content.length).toBeGreaterThan(DISCORD_HARD_LIMIT);

		const { user, sends } = makeRecordingUser();
		await sendDmInChunks(user, content, [], undefined);

		expect(sends.length).toBeGreaterThan(1);
		for (const options of sends) {
			// Every chunk must contain an even number of fence markers so its
			// fenced blocks are balanced (opened fences get closed at the chunk
			// end and reopened at the start of the next chunk).
			const fenceMarkers =
				options.content.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? [];
			expect(fenceMarkers.length % 2).toBe(0);
			expect(options.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
		}
	});

	it("passes an under-budget message through as exactly ONE send (no regression)", async () => {
		const content = "short reply that fits in one Discord message";
		const { user, sends } = makeRecordingUser();
		const messages = await sendDmInChunks(user, content, [], undefined);

		expect(sends.length).toBe(1);
		expect(messages.length).toBe(1);
		expect(sends[0].content).toBe(content);
		expect(sends[0].files).toBeUndefined();
		expect(sends[0].components).toBeUndefined();
	});

	it("preserves chunk ordering across sequential sends", async () => {
		const content = Array.from(
			{ length: 400 },
			(_, i) => `line-${String(i).padStart(3, "0")}`,
		).join("\n");
		expect(content.length).toBeGreaterThan(DISCORD_HARD_LIMIT);

		const { user, sends } = makeRecordingUser();
		await sendDmInChunks(user, content, [], undefined);

		expect(sends.length).toBeGreaterThan(1);
		const seen: number[] = [];
		for (const options of sends) {
			for (const match of options.content.matchAll(/line-(\d{3})/g)) {
				seen.push(Number(match[1]));
			}
		}
		expect(seen.length).toBe(400);
		const sorted = [...seen].sort((a, b) => a - b);
		expect(seen).toEqual(sorted);
	});

	it("rides files on the LAST chunk only, mirroring sendMessageInChunks", async () => {
		const content = Array.from(
			{ length: 300 },
			(_, i) => `attachment ordering line ${i}`,
		).join("\n");
		expect(content.length).toBeGreaterThan(DISCORD_HARD_LIMIT);

		const fakeFile = { name: "report.txt" } as never;
		const { user, sends } = makeRecordingUser();
		await sendDmInChunks(user, content, [fakeFile], undefined);

		expect(sends.length).toBeGreaterThan(1);
		for (let i = 0; i < sends.length; i++) {
			if (i === sends.length - 1) {
				expect(sends[i].files).toEqual([fakeFile]);
			} else {
				expect(sends[i].files).toBeUndefined();
			}
		}
	});

	it("still delivers a components/files-only reply with empty prose as one send", async () => {
		const fakeRow = { components: [] } as never;
		const { user, sends } = makeRecordingUser();
		const messages = await sendDmInChunks(user, "", [], [fakeRow]);

		expect(sends.length).toBe(1);
		expect(messages.length).toBe(1);
		expect(sends[0].components).toEqual([fakeRow]);
	});
});
