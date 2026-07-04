/**
 * Covers `createCoreSecurityHooksPlugin`: that its `init` registers both core
 * message-path security pipeline hooks (incoming-message-security and
 * should-respond injection-risk) on the correct phases. Verified against a
 * hand-rolled runtime stub and a real `AgentRuntime` boot (in-memory DB,
 * migrations skipped).
 */
import { describe, expect, it } from "vitest";

import { AgentRuntime } from "../runtime.ts";
import type { PipelineHookSpec } from "../types/pipeline-hooks.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	CORE_SECURITY_HOOKS_PLUGIN_NAME,
	createCoreSecurityHooksPlugin,
} from "./core-security-hooks.ts";

describe("core security hooks plugin (#12091 item 23)", () => {
	it("registers both message-path security hooks through plugin init", async () => {
		const registered: PipelineHookSpec[] = [];
		const runtime = {
			registerPipelineHook: (spec: PipelineHookSpec) => {
				registered.push(spec);
			},
		} as unknown as IAgentRuntime;

		const plugin = createCoreSecurityHooksPlugin();
		expect(plugin.name).toBe(CORE_SECURITY_HOOKS_PLUGIN_NAME);
		expect(plugin.init).toBeTypeOf("function");

		await plugin.init?.({}, runtime);

		const ids = registered.map((s) => s.id).sort();
		expect(ids).toEqual([
			"core:incoming-message-security",
			"core:should-respond-injection-risk",
		]);

		const incoming = registered.find(
			(s) => s.id === "core:incoming-message-security",
		);
		expect(incoming?.phase).toBe("incoming_before_compose");
		const risk = registered.find(
			(s) => s.id === "core:should-respond-injection-risk",
		);
		expect(risk?.phase).toBe("parallel_with_should_respond");
	});

	it("registers through the real boot path into plugin bookkeeping", async () => {
		// Boot a real runtime the way `initialize` does; the security plugin must
		// land in `runtime.plugins`, proving `registerPlugin` owns its lifecycle.
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		try {
			const names = runtime.plugins.map((p) => p.name);
			expect(names).toContain(CORE_SECURITY_HOOKS_PLUGIN_NAME);
		} finally {
			await runtime.stop();
		}
	});
});
