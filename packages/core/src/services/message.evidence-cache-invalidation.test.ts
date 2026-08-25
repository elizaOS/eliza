/**
 * Within-turn freshness for retrieval providers: when a planner action settles
 * carrying substantive new text (an ATTACHMENT page read, a WEB_FETCH body),
 * the FACTS and relevant-conversations entries must be evicted from the
 * turn's cached provider state so the next composeState re-runs retrieval
 * with the new evidence tokens in scope. Diagnosed live 2026-08-21: an
 * ATTACHMENT read injected page text containing "ZCash" — the token that
 * would have BM25-matched a stored fact — but compose #2 logged
 * `provider-cache:FACTS cacheHit:true` and reused the pre-attachment output.
 */
import { describe, expect, it } from "vitest";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../types/index.ts";
import { __invalidateEvidenceSensitiveProviderCacheForTests } from "./message.ts";

const messageId = "00000000-0000-0000-0000-0000000000e1" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000e2" as UUID;

function makeMessage(): Memory {
	return {
		id: messageId,
		entityId: "00000000-0000-0000-0000-0000000000e3" as UUID,
		roomId,
		content: { text: "wait we're in season 3... grov3.net" },
	} as Memory;
}

function makeRuntimeWithCachedProviders(providers: Record<string, unknown>): {
	runtime: IAgentRuntime;
	cachedProviders: Record<string, unknown>;
} {
	const cachedState = {
		values: {},
		data: { providers },
		text: "",
	} as unknown as State;
	const stateCache = new Map<string, State>([[messageId, cachedState]]);
	const runtime = { stateCache } as unknown as IAgentRuntime;
	return { runtime, cachedProviders: providers };
}

const longEvidence =
	"Pillar IV Private Communication: FlashNet node, TorDash, ZCash infra. ".repeat(
		5,
	);

describe("invalidateEvidenceSensitiveProviderCache", () => {
	it("evicts FACTS and relevant-conversations when an action adds substantive text", () => {
		const { runtime, cachedProviders } = makeRuntimeWithCachedProviders({
			FACTS: { text: "stale pre-attachment facts" },
			"relevant-conversations": { text: "stale snippets" },
			CURRENT_TIME: { text: "clock" },
		});
		const result: ActionResult = {
			success: true,
			text: longEvidence,
			data: { actionName: "ATTACHMENT" },
		};

		__invalidateEvidenceSensitiveProviderCacheForTests(
			runtime,
			makeMessage(),
			result,
		);

		expect(cachedProviders).not.toHaveProperty("FACTS");
		expect(cachedProviders).not.toHaveProperty("relevant-conversations");
		// Unrelated providers keep their cached entries.
		expect(cachedProviders).toHaveProperty("CURRENT_TIME");
	});

	it("counts data.content toward the evidence threshold (ATTACHMENT stores page text there)", () => {
		const { runtime, cachedProviders } = makeRuntimeWithCachedProviders({
			FACTS: { text: "stale" },
		});
		const result: ActionResult = {
			success: true,
			text: "ok",
			data: { actionName: "ATTACHMENT", content: longEvidence },
		};

		__invalidateEvidenceSensitiveProviderCacheForTests(
			runtime,
			makeMessage(),
			result,
		);

		expect(cachedProviders).not.toHaveProperty("FACTS");
	});

	it("leaves the cache intact for terse control results", () => {
		const { runtime, cachedProviders } = makeRuntimeWithCachedProviders({
			FACTS: { text: "still fresh enough" },
		});
		const result: ActionResult = {
			success: true,
			text: "ok",
			data: { actionName: "IGNORE" },
		};

		__invalidateEvidenceSensitiveProviderCacheForTests(
			runtime,
			makeMessage(),
			result,
		);

		expect(cachedProviders).toHaveProperty("FACTS");
	});

	it("is a no-op when the message has no id or no cached state", () => {
		const { runtime } = makeRuntimeWithCachedProviders({});
		const noIdMessage = { ...makeMessage(), id: undefined } as Memory;
		const result: ActionResult = { success: true, text: longEvidence };

		expect(() =>
			__invalidateEvidenceSensitiveProviderCacheForTests(
				runtime,
				noIdMessage,
				result,
			),
		).not.toThrow();

		const emptyRuntime = {
			stateCache: new Map<string, State>(),
		} as unknown as IAgentRuntime;
		expect(() =>
			__invalidateEvidenceSensitiveProviderCacheForTests(
				emptyRuntime,
				makeMessage(),
				result,
			),
		).not.toThrow();
	});
});
