import { initializeTestRuntime } from "@elizaos/testing/runtime";
/**
 * Covers `createCoreSecurityHooksPlugin`: that its `init` registers both core
 * message-path security pipeline hooks (incoming-message-security and
 * should-respond injection-risk) on the correct phases. Verified against a
 * real runtime initialization and a full `AgentRuntime` boot (in-memory DB,
 * migrations skipped). Also covers that a turn the incoming hook wrapped is
 * rendered as history without replaying its warning.
 */

import { describe, expect, it } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";

import { AgentRuntime } from "../src/runtime.ts";
import {
	CORE_SECURITY_HOOKS_PLUGIN_NAME,
	createCoreSecurityHooksPlugin,
} from "../src/security/core-hooks.ts";
import type { Memory } from "../src/types/memory.ts";
import {
	incomingPipelineHookContext,
	type PipelineHookSpec,
} from "../src/types/pipeline-hooks.ts";
import type { UUID } from "../src/types/primitives.ts";
import { formatMessages } from "../src/utils.ts";

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

	it("does not replay the incoming-message warning when the stored turn is rendered as history", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		try {
			await createCoreSecurityHooksPlugin().init?.({}, runtime);
			const entityId = "33333333-3333-4333-8333-333333333333" as UUID;
			const roomId = "44444444-4444-4444-8444-444444444444" as UUID;
			const message: Memory = {
				id: "11111111-1111-4111-8111-111111111111" as UUID,
				entityId,
				agentId: runtime.agentId,
				roomId,
				createdAt: 1_700_000_000_000,
				content: { text: "Can you check the build logs?", source: "discord" },
			};
			await runtime.applyPipelineHooks(
				"incoming_before_compose",
				incomingPipelineHookContext(message, {
					roomId,
					responseId: "55555555-5555-4555-8555-555555555555" as UUID,
					runId: "66666666-6666-4666-8666-666666666666" as UUID,
				}),
			);
			// The hook stores the Discord turn inside the incoming-message envelope.
			expect(message.content.text).toContain(
				"This is the current sender's message",
			);

			const history = formatMessages({
				messages: [message],
				entities: [{ id: entityId, agentId: runtime.agentId, names: ["Ana"] }],
			});
			expect(history).toContain("Can you check the build logs?");
			expect(history).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
			expect(history).not.toContain("SECURITY NOTICE");
		} finally {
			await runtime.stop();
		}
	});
});
