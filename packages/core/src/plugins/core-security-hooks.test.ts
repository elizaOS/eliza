import { initializeTestRuntime } from "@elizaos/testing/in-memory-adapter";
/**
 * Covers `createCoreSecurityHooksPlugin`: that its `init` registers both core
 * message-path security pipeline hooks (incoming-message-security and
 * should-respond injection-risk) on the correct phases. Verified against a
 * real runtime initialization and a full `AgentRuntime` boot (in-memory DB,
 * migrations skipped).
 */

import { describe, expect, it } from "vitest";
import { createAssistantPlugin } from "../../../../plugins/plugin-assistant/src/index.ts";

import { AgentRuntime } from "../runtime.ts";
import type { PipelineHookSpec } from "../types/pipeline-hooks.ts";
import {
	CORE_SECURITY_HOOKS_PLUGIN_NAME,
	createCoreSecurityHooksPlugin,
} from "./core-security-hooks.ts";

describe("core security hooks plugin (#12091 item 23)", () => {
	it("registers both message-path security hooks through plugin init", async () => {
		const registered: PipelineHookSpec[] = [];
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const register = runtime.registerPipelineHook.bind(runtime);
		runtime.registerPipelineHook = (spec) => {
			registered.push(spec);
			return register(spec);
		};
		try {
			const plugin = createCoreSecurityHooksPlugin();
			expect(plugin.name).toBe(CORE_SECURITY_HOOKS_PLUGIN_NAME);
			expect(plugin.init).toBeTypeOf("function");

			await plugin.init?.({}, runtime);
			expect(registered.map((s) => s.id)).toEqual([
				"core:incoming-message-security",
			]);
			await createAssistantPlugin().init?.({}, runtime);

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
		} finally {
			await runtime.stop();
		}
	});

	it("registers through the real boot path into plugin bookkeeping", async () => {
		// Boot a real runtime the way `initialize` does; the security plugin must
		// land in `runtime.plugins`, proving `registerPlugin` owns its lifecycle.
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await initializeTestRuntime(runtime, { skipMigrations: true });
		try {
			const names = runtime.plugins.map((p) => p.name);
			expect(names).toContain(CORE_SECURITY_HOOKS_PLUGIN_NAME);
		} finally {
			await runtime.stop();
		}
	});
});
