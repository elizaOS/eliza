/**
 * A fresh salt per turn gave a name or address a new pseudonym on every turn,
 * so a line of history was sent with different bytes each time and a
 * provider's prompt cache missed from that message on. A host that keeps
 * references stable for a conversation keeps its pseudonyms too.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { runWithTrajectoryContext } from "../src/trajectory-context.ts";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

// Two addresses, so two sessions that differ cannot agree by chance.
const home = {
	role: "user",
	content: "I live at 742 Evergreen Terrace and work at 31 Spooner Street",
};
const PSEUDONYMIZED =
	/^I live at (?!742 Evergreen)\d+ [A-Z]\w+ [A-Z]\w+ and work at (?!31 Spooner)\d+ [A-Z]\w+ [A-Z]\w+$/;

/** One turn per room; returns the history line as each request carried it. */
async function sentHistoryLine(
	settings: Record<string, string>,
	rooms: (string | undefined)[],
): Promise<string[]> {
	const runtime = createSQLiteTestRuntime({
		character: { name: "A", bio: "t", settings } as Character,
		logLevel: "fatal",
	});
	const sent: string[] = [];
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params) => {
			const { messages } = params as { messages: { content: string }[] };
			sent.push(messages[0].content);
			return "ok";
		},
		"p",
	);
	for (const [turn, roomId] of rooms.entries())
		await runWithTrajectoryContext(roomId ? { roomId } : undefined, () =>
			runtime.useModel(ModelType.TEXT_LARGE, {
				// A later turn resends the line with more of the conversation after it.
				messages: [
					home,
					...Array.from({ length: turn }, () => [
						{ role: "assistant", content: "Noted." },
						{ role: "user", content: "And 12 Main Street is the gym." },
					]).flat(),
				],
			} as never),
		);
	await runtime.stop();
	return sent;
}

it("keeps a value's pseudonym for a conversation when the host keeps references stable", async () => {
	const [first, again, otherRoom, noRoom, noRoomAgain] = await sentHistoryLine(
		{
			ELIZA_PII_SWAP_ENABLED: "true",
			ELIZA_SECRET_SWAP_STABLE_REFERENCES: "true",
		},
		["room-a", "room-a", "room-b", undefined, undefined],
	);
	for (const line of [first, otherRoom, noRoom, noRoomAgain])
		expect(line).toMatch(PSEUDONYMIZED);
	expect(again).toBe(first);
	expect(otherRoom).not.toBe(first);
	// A call outside a conversation has no later turn to match: fresh each time.
	expect(noRoom).not.toBe(first);
	expect(noRoomAgain).not.toBe(noRoom);
});

it("draws new pseudonyms every turn unless the host turns stable references on", async () => {
	const [first, again] = await sentHistoryLine(
		{ ELIZA_PII_SWAP_ENABLED: "true" },
		["room-a", "room-a"],
	);
	expect(first).toMatch(PSEUDONYMIZED);
	expect(again).toMatch(PSEUDONYMIZED);
	expect(again).not.toBe(first);
});
