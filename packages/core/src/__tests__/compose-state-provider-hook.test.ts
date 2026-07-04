/**
 * Exercises the `compose_state_providers` pipeline hook on
 * `AgentRuntime.composeState`: a hook may filter and add providers, pass through
 * unchanged, and a corrupted or thrown hook falls back to the pre-hook
 * selection. Uses a real in-memory AgentRuntime with synthetic providers; no
 * database or model.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, Provider, UUID } from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeProvider(
	name: string,
	text: string,
	extra: Partial<Provider> = {},
): Provider {
	return {
		name,
		get: async () => ({ text, values: {}, data: {} }),
		...extra,
	};
}

function makeMessage(id: string): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "gm" },
	};
}

function newRuntime(name: string): AgentRuntime {
	const runtime = new AgentRuntime({ character: { name } as Character });
	runtime.registerProvider(makeProvider("WALLET", "WALLET_BALANCE_HEAVY"));
	runtime.registerProvider(makeProvider("GREETING", "HELLO_THERE"));
	// Dynamic providers are excluded from default selection; a hook can opt one in.
	runtime.registerProvider(
		makeProvider("CRYPTO_SWAP", "SWAP_READY", { dynamic: true }),
	);
	return runtime;
}

describe("compose_state_providers pipeline hook", () => {
	it("runs every registered (non-dynamic) provider when no hook is set", async () => {
		const runtime = newRuntime("compose-hook-baseline");
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			null,
			false,
			true,
		);
		const order = state.data.providerOrder as string[];
		expect(order).toContain("WALLET");
		expect(order).toContain("GREETING");
		// CRYPTO_SWAP is dynamic — never in the default set without opt-in.
		expect(order).not.toContain("CRYPTO_SWAP");
		expect(state.text).toContain("WALLET_BALANCE_HEAVY");
	});

	it("lets a hook filter out and add providers by name", async () => {
		const runtime = newRuntime("compose-hook-filter");
		runtime.registerPipelineHook({
			id: "intent-filter",
			phase: "compose_state_providers",
			handler: (_rt, ctx) => {
				if (ctx.phase !== "compose_state_providers") return;
				ctx.providers.current = [
					...ctx.providers.current.filter((n) => n !== "WALLET"),
					"CRYPTO_SWAP",
				];
			},
		});

		const state = await runtime.composeState(
			makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
			null,
			false,
			true,
		);
		const order = state.data.providerOrder as string[];
		expect(order).not.toContain("WALLET");
		expect(order).toContain("GREETING");
		// A dynamic provider named explicitly by the hook is pulled in.
		expect(order).toContain("CRYPTO_SWAP");
		expect(state.text).toContain("SWAP_READY");
		expect(state.text).toContain("HELLO_THERE");
		expect(state.text).not.toContain("WALLET_BALANCE_HEAVY");
	});

	it("is a pure pass-through when the hook returns the list unmodified", async () => {
		const runtime = newRuntime("compose-hook-passthrough");
		runtime.registerPipelineHook({
			id: "noop",
			phase: "compose_state_providers",
			handler: () => {
				// no-op
			},
		});

		const state = await runtime.composeState(
			makeMessage("cccccccc-cccc-cccc-cccc-cccccccccccc"),
			null,
			false,
			true,
		);
		const order = state.data.providerOrder as string[];
		expect(order).toContain("WALLET");
		expect(order).toContain("GREETING");
		expect(order).not.toContain("CRYPTO_SWAP");
	});

	it("keeps the pre-hook selection when a hook corrupts providers.current", async () => {
		const runtime = newRuntime("compose-hook-nonarray");
		runtime.registerPipelineHook({
			id: "corrupt",
			phase: "compose_state_providers",
			handler: (_rt, ctx) => {
				if (ctx.phase !== "compose_state_providers") return;
				// Type-erased at runtime: a buggy hook hands back a non-array.
				(ctx.providers as { current: unknown }).current = "WALLET";
			},
		});

		const state = await runtime.composeState(
			makeMessage("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
			null,
			false,
			true,
		);
		const order = state.data.providerOrder as string[];
		// Falls back to the pre-hook set instead of crashing or emptying.
		expect(order).toContain("WALLET");
		expect(order).toContain("GREETING");
	});

	it("does not crash when a hook throws after a partial mutation", async () => {
		const runtime = newRuntime("compose-hook-throw");
		runtime.registerPipelineHook({
			id: "throws",
			phase: "compose_state_providers",
			handler: (_rt, ctx) => {
				if (ctx.phase !== "compose_state_providers") return;
				ctx.providers.current = ctx.providers.current.filter(
					(n) => n !== "WALLET",
				);
				throw new Error("boom");
			},
		});

		// The thrown error is swallowed by invokePipelineHooks; composeState resolves.
		const state = await runtime.composeState(
			makeMessage("ffffffff-ffff-ffff-ffff-ffffffffffff"),
			null,
			false,
			true,
		);
		const order = state.data.providerOrder as string[];
		expect(order).toContain("GREETING");
	});

	it("surfaces onlyInclude and the message to the hook", async () => {
		const runtime = newRuntime("compose-hook-context");
		let seenOnlyInclude: boolean | undefined;
		let seenMessageId: string | undefined;
		let seenNames: string[] | undefined;
		runtime.registerPipelineHook({
			id: "capture",
			phase: "compose_state_providers",
			handler: (_rt, ctx) => {
				if (ctx.phase !== "compose_state_providers") return;
				seenOnlyInclude = ctx.onlyInclude;
				seenMessageId = ctx.message.id;
				seenNames = [...ctx.providers.current];
			},
		});

		await runtime.composeState(
			makeMessage("dddddddd-dddd-dddd-dddd-dddddddddddd"),
			["GREETING"],
			true,
			true,
		);
		expect(seenOnlyInclude).toBe(true);
		expect(seenMessageId).toBe("dddddddd-dddd-dddd-dddd-dddddddddddd");
		// onlyInclude=true ⇒ the proposed set is exactly the caller's include-list.
		expect(seenNames).toEqual(["GREETING"]);
	});
});
