import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../types/index";
import { factsProvider } from "./facts.ts";

function makeRuntime(
	useModelImpl: () => Promise<unknown>,
): Pick<
	IAgentRuntime,
	"useModel" | "getMemories" | "searchMemories" | "character" | "logger"
> {
	return {
		character: { name: "TestAgent" } as IAgentRuntime["character"],
		useModel: vi.fn(useModelImpl) as unknown as IAgentRuntime["useModel"],
		getMemories: vi.fn(async () => [
			{
				id: "m1",
				entityId: "user-1",
				roomId: "room-1",
				content: { text: "hello world" },
			} as Memory,
		]),
		searchMemories: vi.fn(async () => []),
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
		} as unknown as IAgentRuntime["logger"],
	};
}

function makeMessage(): Memory {
	return {
		id: "msg-1",
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "what's up" },
	} as Memory;
}

describe("FACTS provider — embedding-timeout degradation", () => {
	it("returns empty facts well under the 30s outer timeout when the embedding hangs", async () => {
		const runtime = makeRuntime(
			() =>
				new Promise<never>(() => {
					/* never resolves — simulates a broken local embedding binding */
				}),
		);

		const start = Date.now();
		const result = await factsProvider.get!(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			{} as State,
		);
		const elapsed = Date.now() - start;

		// EMBEDDING_TIMEOUT_MS is 3000ms; provider must bail within ~3.5s, not 30s.
		expect(elapsed).toBeLessThan(4000);
		expect(result.values?.facts).toBe("");
		expect(result.text).toBe("No facts available.");
	}, 8000);

	it("returns empty facts when the embedding call throws", async () => {
		const runtime = makeRuntime(async () => {
			throw new Error("embedding backend offline");
		});

		const result = await factsProvider.get!(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			{} as State,
		);

		expect(result.values?.facts).toBe("");
		expect(result.text).toBe("No facts available.");
		expect(result.data?.error).toContain("offline");
	});
});
