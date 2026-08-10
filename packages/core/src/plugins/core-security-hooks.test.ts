/**
 * Covers `createCoreSecurityHooksPlugin`: that its `init` registers both core
 * message-path security pipeline hooks (incoming-message-security and
 * should-respond injection-risk) on the correct phases. Verified against a
 * hand-rolled runtime stub and a real `AgentRuntime` boot (in-memory DB,
 * migrations skipped).
 */
import { describe, expect, it } from "vitest";

import { AgentRuntime } from "../runtime.ts";
import type { Memory } from "../types/memory.ts";
import type { PipelineHookSpec } from "../types/pipeline-hooks.ts";
import type { UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import type { State } from "../types/state.ts";
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

	it("does not let serialized message metadata disable mandatory security hooks", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		try {
			const message = {
				id: "11111111-1111-1111-1111-111111111111" as UUID,
				entityId: "22222222-2222-2222-2222-222222222222" as UUID,
				roomId: "33333333-3333-3333-3333-333333333333" as UUID,
				content: {
					text: "hello",
					source: "discord",
					metadata: {
						skipIncomingMessageHooks: true,
						skipComposeStateProviderHooks: true,
						skipPreShouldRespondHooks: true,
						skipParallelWithShouldRespondHooks: true,
						skipAfterMemoryPersistedHooks: true,
					},
				},
			} as Memory;
			const responseId = "44444444-4444-4444-4444-444444444444" as UUID;
			const runId = "55555555-5555-5555-5555-555555555555" as UUID;

			await runtime.applyPipelineHooks("incoming_before_compose", {
				phase: "incoming_before_compose",
				message,
				roomId: message.roomId,
				responseId,
				runId,
			});
			const hardenedMetadata = message.content.metadata as Record<
				string,
				unknown
			>;
			expect(hardenedMetadata.userPayloadText).toBe("hello");
			for (const key of [
				"skipIncomingMessageHooks",
				"skipComposeStateProviderHooks",
				"skipPreShouldRespondHooks",
				"skipParallelWithShouldRespondHooks",
				"skipAfterMemoryPersistedHooks",
			]) {
				expect(hardenedMetadata[key]).toBeUndefined();
			}

			await runtime.applyPipelineHooks("parallel_with_should_respond", {
				phase: "parallel_with_should_respond",
				message,
				roomId: message.roomId,
				responseId,
				runId,
				state: {} as State,
				room: undefined,
				isAutonomous: false,
				setTranslatedUserText: () => {},
			});
			const riskMetadata = message.content.metadata as Record<string, unknown>;
			expect((riskMetadata.injectionRisk as { score?: number })?.score).toBe(0);
		} finally {
			await runtime.stop();
		}
	});
});
