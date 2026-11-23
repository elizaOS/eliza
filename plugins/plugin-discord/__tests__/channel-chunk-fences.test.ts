import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// A local stand-in for the Discord REST API with the real discord.js client.
// It stores each created message, but its first answer is lost (502 or a
// timeout), so discord.js sends the same create again. Like Discord, it
// returns the stored message for a repeated enforced nonce.
describe("sendMessageInChunks when discord.js sends a create again", () => {
	type Stored = { id: string; content: string; nonce?: unknown };
	let stored: Stored[] = [];
	let mode: "500" | "slow" = "500";
	let postCount = 0;
	const author = {
		id: "999",
		username: "bot",
		discriminator: "0",
		avatar: null,
		bot: true,
	};
	function messageJson(id: string, content: string) {
		return {
			id,
			channel_id: "111",
			content,
			author,
			timestamp: new Date().toISOString(),
			edited_timestamp: null,
			tts: false,
			mention_everyone: false,
			mentions: [],
			mention_roles: [],
			attachments: [],
			embeds: [],
			pinned: false,
			type: 0,
		};
	}

	let server: Server;
	let port = 0;

	beforeAll(async () => {
		server = createServer(async (req, res) => {
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			const path = req.url ?? "";
			if (req.method === "GET" && path.endsWith("/channels/111")) {
				return send(200, {
					id: "111",
					type: 1,
					last_message_id: null,
					recipients: [
						{ id: "222", username: "user", discriminator: "0", avatar: null },
					],
				});
			}
			if (req.method === "POST" && path.endsWith("/channels/111/messages")) {
				postCount += 1;
				let raw = "";
				for await (const chunk of req) raw += chunk;
				const body = JSON.parse(raw) as {
					content: string;
					nonce?: unknown;
					enforce_nonce?: boolean;
				};
				// Discord: an enforced nonce already used by this author returns
				// the stored message instead of creating a new one.
				const prior = body.enforce_nonce
					? stored.find((m) => m.nonce !== undefined && m.nonce === body.nonce)
					: undefined;
				if (prior) return send(200, messageJson(prior.id, prior.content));
				const id = String(1000 + stored.length);
				stored.push({ id, content: body.content, nonce: body.nonce });
				if (postCount === 1) {
					if (mode === "500")
						return send(502, { message: "upstream", code: 0 });
					await new Promise((r) => setTimeout(r, 700)); // > client REST timeout
				}
				return send(200, messageJson(id, body.content));
			}
			return send(404, { message: "not found" });
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(() => server.close());

	async function run(m: "500" | "slow") {
		stored = [];
		postCount = 0;
		mode = m;
		const client = new Client({
			intents: [],
			rest: {
				api: `http://127.0.0.1:${port}/api`,
				...(m === "slow" ? { timeout: 300 } : {}),
			},
		});
		client.rest.setToken("fake-token");
		const channel = await client.channels.fetch("111");
		const sent = await sendMessageInChunks(
			channel as never,
			"Your transfer of 5 USDC was submitted.",
			"",
			[],
		);
		client.destroy();
		return { sent, stored: [...stored] };
	}

	for (const [mode, label] of [
		["500", "a 502 answer"],
		["slow", "a timeout"],
	] as const) {
		it(`stores the reply once when Discord kept the message but ${label} made discord.js send it again`, async () => {
			const { sent, stored } = await run(mode);
			console.log(
				`[${mode}] posts:`,
				postCount,
				"stored:",
				stored.length,
				"nonce:",
				stored[0]?.nonce,
			);
			expect(postCount).toBe(2);
			expect(sent.length).toBe(1);
			expect(stored.length).toBe(1);
		});
	}
});
