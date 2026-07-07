/**
 * Coverage for the explicit component-precedence policy (#12658 / arch-audit
 * #12089 item 8).
 *
 * The three primary component registries (actions, providers, evaluators)
 * previously resolved same-name collisions with a SILENT first-wins dedupe:
 * whichever plugin registered first won, later duplicates were dropped at
 * `debug` with no observable signal, and there was no way to declare that a
 * later component intentionally supersedes an earlier one.
 *
 * These tests pin the new contract:
 *  - undeclared collision -> keep the incumbent (still deterministic first-wins)
 *    AND emit an observable `logger.warn` instead of a silent `debug`.
 *  - `override: true` on the later registrant -> replace the incumbent and log
 *    the takeover at `info`.
 *  - the same policy applies whether components arrive via the direct
 *    `register*` methods or through `registerPlugin` (no silent pre-filter).
 *
 * Drives a real `AgentRuntime`; no model.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type {
	Action,
	ActionResult,
	Character,
	Provider,
	RegisteredEvaluator,
} from "../types";

function makeRuntime(name: string): AgentRuntime {
	return new AgentRuntime({ character: { name } as Character });
}

function makeProvider(name: string, text: string): Provider {
	// Declare `contexts` so registration does not trip the PluginLifecycle
	// "provider declares no contexts/contextGate" nudge (materializeProviderContexts,
	// plugin-lifecycle.ts) — an orthogonal warn that would otherwise pollute these
	// tests' collision-warning counts.
	return {
		name,
		contexts: ["general"],
		get: async () => ({ text, values: {}, data: {} }),
	};
}

function makeAction(name: string, tag: string): Action {
	return {
		name,
		description: tag,
		validate: async () => true,
		handler: async (): Promise<ActionResult> => ({
			success: true,
			text: tag,
		}),
		examples: [],
	};
}

function makeEvaluator(name: string, description: string): RegisteredEvaluator {
	return {
		name,
		description,
		schema: { type: "object" },
		shouldRun: async () => false,
		prompt: () => "",
	} as RegisteredEvaluator;
}

describe("AgentRuntime component precedence — undeclared collisions (first-wins + WARN)", () => {
	it("keeps the first provider and WARNs on an undeclared name collision", async () => {
		const runtime = makeRuntime("provider-collision-warn");
		const warn = vi.spyOn(runtime.logger, "warn");

		runtime.registerProvider(makeProvider("DUP", "first"));
		runtime.registerProvider(makeProvider("DUP", "second"));

		const matches = runtime.providers.filter((p) => p.name === "DUP");
		expect(matches).toHaveLength(1);
		// Incumbent (first) is authoritative.
		const dup = matches[0];
		expect(dup).toBeDefined();
		const result = await dup!.get(runtime, {} as never, {} as never);
		expect(result.text).toBe("first");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[1]).toMatch(/name collision/i);
	});

	it("keeps the first action and WARNs on an undeclared name collision", () => {
		const runtime = makeRuntime("action-collision-warn");
		const warn = vi.spyOn(runtime.logger, "warn");

		runtime.registerAction(makeAction("DUP_ACTION", "first"));
		runtime.registerAction(makeAction("DUP_ACTION", "second"));

		const matches = runtime.actions.filter((a) => a.name === "DUP_ACTION");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("first");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[1]).toMatch(/name collision/i);
	});

	it("keeps the first evaluator and WARNs on an undeclared name collision", () => {
		const runtime = makeRuntime("evaluator-collision-warn");
		const warn = vi.spyOn(runtime.logger, "warn");

		runtime.registerEvaluator(makeEvaluator("DUP_EVAL", "first"));
		runtime.registerEvaluator(makeEvaluator("DUP_EVAL", "second"));

		const matches = runtime.evaluators.filter((e) => e.name === "DUP_EVAL");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("first");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[1]).toMatch(/name collision/i);
	});
});

describe("AgentRuntime component precedence — declared override:true supersedes + INFO", () => {
	it("replaces the incumbent provider when the newcomer declares override:true", async () => {
		const runtime = makeRuntime("provider-override");
		const info = vi.spyOn(runtime.logger, "info");
		const warn = vi.spyOn(runtime.logger, "warn");

		runtime.registerProvider(makeProvider("OVR", "first"));
		runtime.registerProvider({
			...makeProvider("OVR", "second"),
			override: true,
		});

		const matches = runtime.providers.filter((p) => p.name === "OVR");
		expect(matches).toHaveLength(1);
		const ovr = matches[0];
		expect(ovr).toBeDefined();
		const result = await ovr!.get(runtime, {} as never, {} as never);
		expect(result.text).toBe("second");
		// Declared override logs at info, never warns.
		expect(info).toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("replaces the incumbent action when the newcomer declares override:true", () => {
		const runtime = makeRuntime("action-override");
		const info = vi.spyOn(runtime.logger, "info");
		const warn = vi.spyOn(runtime.logger, "warn");

		runtime.registerAction(makeAction("OVR_ACTION", "first"));
		runtime.registerAction({
			...makeAction("OVR_ACTION", "second"),
			override: true,
		});

		const matches = runtime.actions.filter((a) => a.name === "OVR_ACTION");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("second");
		expect(info).toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("replaces the incumbent evaluator when the newcomer declares override:true", () => {
		const runtime = makeRuntime("evaluator-override");
		const info = vi.spyOn(runtime.logger, "info");
		const warn = vi.spyOn(runtime.logger, "warn");

		runtime.registerEvaluator(makeEvaluator("OVR_EVAL", "first"));
		runtime.registerEvaluator({
			...makeEvaluator("OVR_EVAL", "second"),
			override: true,
		});

		const matches = runtime.evaluators.filter((e) => e.name === "OVR_EVAL");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("second");
		expect(info).toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("AgentRuntime component precedence — policy applies through registerPlugin", () => {
	it("routes plugin action collisions through the precedence policy (WARN, not silent)", async () => {
		const runtime = makeRuntime("plugin-collision-warn");
		runtime.registerAction(makeAction("PLUGIN_DUP", "incumbent"));
		const warn = vi.spyOn(runtime.logger, "warn");

		await runtime.registerPlugin({
			name: "collision-plugin",
			description: "collides with an already-registered action",
			actions: [makeAction("PLUGIN_DUP", "from-plugin")],
		});

		const matches = runtime.actions.filter((a) => a.name === "PLUGIN_DUP");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("incumbent");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("downgrades a plugin action's override:true to safe first-wins (WARNs)", async () => {
		// Plugin-boundary overrides are unsafe for hot teardown (#12658): the
		// runtime keeps the incumbent and treats it like an undeclared collision.
		const runtime = makeRuntime("plugin-override-downgrade");
		runtime.registerAction(makeAction("PLUGIN_OVR", "incumbent"));
		const warn = vi.spyOn(runtime.logger, "warn");

		await runtime.registerPlugin({
			name: "override-plugin",
			description: "attempts an intentional override across a plugin boundary",
			actions: [{ ...makeAction("PLUGIN_OVR", "from-plugin"), override: true }],
		});

		const matches = runtime.actions.filter((a) => a.name === "PLUGIN_OVR");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("incumbent");
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("AgentRuntime component precedence — grep guard (silent dedupe removed)", () => {
	it("no longer silently pre-filters plugin action/provider/evaluator duplicates", () => {
		const runtimeSrc = readFileSync(
			fileURLToPath(new URL("../runtime.ts", import.meta.url)),
			"utf8",
		);
		// The primary component registries used to drop same-name duplicates via a
		// silent `debug` pre-filter in registerPlugin. That path is gone; collisions
		// now flow through resolveComponentCollision (WARN / declared override).
		expect(runtimeSrc).not.toContain('"Skipping duplicate plugin action"');
		expect(runtimeSrc).not.toContain('"Skipping duplicate plugin provider"');
		expect(runtimeSrc).not.toContain('"Skipping duplicate plugin evaluator"');
		expect(runtimeSrc).not.toContain(
			'"Evaluator already registered, skipping"',
		);
		// The single-authority collision resolver exists.
		expect(runtimeSrc).toContain("resolveComponentCollision");
	});
});

describe("AgentRuntime component precedence — distinct names still register", () => {
	it("registers distinctly-named components without warning", () => {
		const runtime = makeRuntime("distinct-names");
		const warn = vi.spyOn(runtime.logger, "warn");

		runtime.registerProvider(makeProvider("ALPHA", "a"));
		runtime.registerProvider(makeProvider("BETA", "b"));
		runtime.registerAction(makeAction("DO_ALPHA", "a"));
		runtime.registerAction(makeAction("DO_BETA", "b"));
		runtime.registerEvaluator(makeEvaluator("EVAL_ALPHA", "a"));
		runtime.registerEvaluator(makeEvaluator("EVAL_BETA", "b"));

		expect(runtime.providers.some((p) => p.name === "ALPHA")).toBe(true);
		expect(runtime.providers.some((p) => p.name === "BETA")).toBe(true);
		expect(runtime.actions.some((a) => a.name === "DO_ALPHA")).toBe(true);
		expect(runtime.actions.some((a) => a.name === "DO_BETA")).toBe(true);
		expect(runtime.evaluators.some((e) => e.name === "EVAL_ALPHA")).toBe(true);
		expect(runtime.evaluators.some((e) => e.name === "EVAL_BETA")).toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});
});
