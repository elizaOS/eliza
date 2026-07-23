/**
 * Per-provider composeState time budgets: a provider that exceeds its declared
 * `timeoutMs` degrades to a `deadline_exceeded` failure record for the turn
 * while composition proceeds with every other provider's output. Uses a real
 * in-memory AgentRuntime with synthetic providers; no database or model.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, Provider, UUID } from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeMessage(id: string): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "gm" },
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("composeState per-provider time budget", () => {
	it("truncates a provider that exceeds its declared timeoutMs and keeps the fast ones", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-truncation" } as Character,
		});
		const slow: Provider = {
			name: "SLOW_NETWORK",
			timeoutMs: 300,
			get: async () => {
				await sleep(1_500);
				return { text: "SLOW_RESULT_MUST_NOT_APPEAR", values: {}, data: {} };
			},
		};
		const fast: Provider = {
			name: "FAST_LOCAL",
			get: async () => ({ text: "FAST_RESULT_PRESENT", values: {}, data: {} }),
		};
		runtime.registerProvider(slow);
		runtime.registerProvider(fast);

		const start = Date.now();
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			null,
			false,
			true,
		);
		const elapsed = Date.now() - start;

		expect(state.text).toContain("FAST_RESULT_PRESENT");
		expect(state.text).not.toContain("SLOW_RESULT_MUST_NOT_APPEAR");
		// Compose returns at the slow provider's budget, not its full runtime.
		expect(elapsed).toBeLessThan(1_400);
	});

	it("honors a declared budget larger than the elapsed work", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-headroom" } as Character,
		});
		const withinBudget: Provider = {
			name: "WITHIN_BUDGET",
			timeoutMs: 2_000,
			get: async () => {
				await sleep(400);
				return { text: "WITHIN_BUDGET_PRESENT", values: {}, data: {} };
			},
		};
		runtime.registerProvider(withinBudget);

		const state = await runtime.composeState(
			makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
			null,
			false,
			true,
		);
		expect(state.text).toContain("WITHIN_BUDGET_PRESENT");
	});

	it("ignores sub-floor timeoutMs declarations instead of racing at unusable budgets", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-floor" } as Character,
		});
		const declaredTooLow: Provider = {
			name: "FLOOR_GUARDED",
			// Below the 250ms floor — the runtime default applies instead, so
			// this ordinary-speed provider must not be truncated.
			timeoutMs: 1,
			get: async () => {
				await sleep(50);
				return { text: "FLOOR_GUARDED_PRESENT", values: {}, data: {} };
			},
		};
		runtime.registerProvider(declaredTooLow);

		const state = await runtime.composeState(
			makeMessage("cccccccc-cccc-cccc-cccc-cccccccccccc"),
			null,
			false,
			true,
		);
		expect(state.text).toContain("FLOOR_GUARDED_PRESENT");
	});
});
