import { describe, expect, it } from "vitest";
import { createCharacter } from "../character";
import { ChannelType } from "../types/primitives";
import { stringToUuid } from "../utils/string-to-uuid.js";
import { createInitializedRuntime } from "./initialized-runtime";

describe("fact persistence", () => {
	it("persists both signed values while keeping exact repeated claims idempotent", async () => {
		const runtime = await createInitializedRuntime({
			character: createCharacter({ name: "fact-sign-regression" }),
		});
		const roomId = stringToUuid("fact-sign-room");
		await runtime.ensureConnection({
			entityId: runtime.agentId,
			roomId,
			worldId: stringToUuid("fact-sign-world"),
			channelId: roomId,
			source: "test",
			type: ChannelType.SELF,
		});
		const write = (text: string, suffix: string) =>
			runtime.createMemory(
				{
					id: stringToUuid(`fact-sign-${suffix}`),
					entityId: runtime.agentId,
					roomId,
					content: { text },
				},
				"facts",
			);
		const debit = await write("Balance: -10 USD", "debit");
		const credit = await write("Balance: +10 USD", "credit");
		expect(credit).not.toBe(debit);
		expect(await write("Balance: -10 USD", "repeat")).toBe(debit);
		const facts = await runtime.getMemories({
			roomId,
			tableName: "facts",
			count: 10,
			unique: false,
		});
		expect(facts.map((fact) => fact.content.text).sort()).toEqual([
			"Balance: +10 USD",
			"Balance: -10 USD",
		]);
	});
});
