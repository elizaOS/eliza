import { describe, expect, it } from "vitest";
import { transformCommandToDiscordApi } from "../discord-commands";

describe("transformCommandToDiscordApi", () => {
	it("does not split an emoji when a command description exceeds 100 units", () => {
		const description = `${"a".repeat(98)}😀tail`;
		const payload = transformCommandToDiscordApi({
			name: "ping",
			description,
		}) as { description: string };

		expect(payload.description.length).toBeLessThanOrEqual(100);
		expect(payload.description.toWellFormed()).toBe(payload.description);
		expect(payload.description.endsWith("…")).toBe(true);
		expect(payload.description.includes("😀")).toBe(false);
	});
});
