import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiscordDataToActors } from "./simulationActors";

describe("parseDiscordDataToActors", () => {
	it("groups Discord message exports into legacy-compatible actors", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "social-alpha-"));
		const filePath = path.join(dir, "discord.json");
		await fs.writeFile(
			filePath,
			JSON.stringify({
				messages: [
					{
						authorId: "user-1",
						authorName: "Alice",
						content: "$SOL looks strong",
					},
					{
						authorId: "user-1",
						authorName: "Alice",
						content: "Still bullish",
					},
				],
			}),
		);

		const actors = await parseDiscordDataToActors(filePath, {});

		expect(actors).toHaveLength(1);
		expect(actors[0]).toMatchObject({
			id: "user-1",
			username: "Alice",
			archetype: "technical_analyst",
			preferences: {
				callFrequency: "medium",
				timingBias: "random",
			},
		});
		expect(actors[0].actorSpecificData?.calls).toHaveLength(2);
	});
});
