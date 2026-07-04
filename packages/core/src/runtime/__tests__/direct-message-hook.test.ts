/**
 * Covers the pre-LLM direct-message hook registry: per-runtime registration,
 * first-hook-that-returns-a-result-wins ordering, unregistration, and isolation
 * between runtimes. Pure in-memory — the runtime is a bare stub, no model or DB.
 */
import { describe, expect, it } from "vitest";
import type { ActionResult } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	__resetDirectMessageHooksForTests,
	type DirectMessageHook,
	getDirectMessageHooks,
	registerDirectMessageHook,
	runDirectMessageHooks,
	unregisterDirectMessageHook,
} from "../direct-message-hook";

const makeRuntime = (): IAgentRuntime => ({}) as unknown as IAgentRuntime;
const input = (runtime: IAgentRuntime) => ({
	runtime,
	message: {} as Memory,
	state: {} as State,
});

describe("pre-LLM direct-message hook registry", () => {
	it("returns null when no hook is registered", async () => {
		const runtime = makeRuntime();
		expect(getDirectMessageHooks(runtime)).toEqual([]);
		expect(await runDirectMessageHooks(runtime, input(runtime))).toBeNull();
	});

	it("returns the first hook that produces a result and skips later hooks", async () => {
		const runtime = makeRuntime();
		const calls: string[] = [];
		const deferring: DirectMessageHook = async () => {
			calls.push("deferring");
			return null;
		};
		const handled: DirectMessageHook = async () => {
			calls.push("handled");
			return { success: true, text: "done" } satisfies ActionResult;
		};
		const never: DirectMessageHook = async () => {
			calls.push("never");
			return { success: true, text: "should not run" } satisfies ActionResult;
		};
		registerDirectMessageHook(runtime, deferring);
		registerDirectMessageHook(runtime, handled);
		registerDirectMessageHook(runtime, never);

		const result = await runDirectMessageHooks(runtime, input(runtime));
		expect(result?.text).toBe("done");
		expect(calls).toEqual(["deferring", "handled"]);

		__resetDirectMessageHooksForTests(runtime);
		expect(getDirectMessageHooks(runtime)).toEqual([]);
	});

	it("unregisters a specific hook so it no longer fires", async () => {
		const runtime = makeRuntime();
		const hook: DirectMessageHook = async () => ({
			success: true,
			text: "handled",
		});
		registerDirectMessageHook(runtime, hook);
		expect(await runDirectMessageHooks(runtime, input(runtime))).not.toBeNull();

		unregisterDirectMessageHook(runtime, hook);
		expect(getDirectMessageHooks(runtime)).toEqual([]);
		expect(await runDirectMessageHooks(runtime, input(runtime))).toBeNull();
	});

	it("keeps hooks isolated per runtime", async () => {
		const a = makeRuntime();
		const b = makeRuntime();
		registerDirectMessageHook(a, async () => ({ success: true, text: "a" }));
		expect((await runDirectMessageHooks(a, input(a)))?.text).toBe("a");
		expect(await runDirectMessageHooks(b, input(b))).toBeNull();
	});
});
