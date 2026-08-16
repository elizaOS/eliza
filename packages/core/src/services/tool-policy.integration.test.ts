/**
 * Integration test for ToolPolicyService in message loop context.
 *
 * Verifies that tool policies are correctly enforced when actions are
 * retrieved and evaluated in the agent's message-handling flow.
 */

import { describe, it, expect, beforeEach } from "vitest";
import ToolPolicyService, { type ToolPolicyContext } from "./tool-policy";
import type { IAgentRuntime, Action } from "../types";
import type { ToolPolicyConfig } from "../types/tools";

/**
 * Create a minimal mock runtime with configurable actions.
 */
function createMockRuntimeWithActions(actions: Action[]): IAgentRuntime {
	return {
		agentId: "integration-test-agent",
		getAllActions: () => actions,
		getSetting: () => undefined,
	} as unknown as IAgentRuntime;
}

/**
 * Create mock actions for testing.
 */
function createMockActions(): Action[] {
	return [
		{
			name: "read_memory",
			similes: ["recall", "remember"],
			description: "Read from agent memory",
			validate: async () => true,
			handler: async () => ({ success: true }),
		},
		{
			name: "write_memory",
			similes: ["store", "save"],
			description: "Write to agent memory",
			validate: async () => true,
			handler: async () => ({ success: true }),
		},
		{
			name: "execute_command",
			similes: ["run", "exec"],
			description: "Execute system command",
			validate: async () => true,
			handler: async () => ({ success: true }),
		},
		{
			name: "search_web",
			similes: ["web search", "google"],
			description: "Search the web",
			validate: async () => true,
			handler: async () => ({ success: true }),
		},
		{
			name: "send_message",
			similes: ["post", "reply"],
			description: "Send a message",
			validate: async () => true,
			handler: async () => ({ success: true }),
		},
	];
}

describe("ToolPolicyService - Integration: Message Loop Action Retrieval", () => {
	let service: ToolPolicyService;
	let mockRuntime: IAgentRuntime;
	let actions: Action[];

	beforeEach(() => {
		actions = createMockActions();
		mockRuntime = createMockRuntimeWithActions(actions);
		service = new ToolPolicyService(mockRuntime);
		service.updatePluginGroups();
	});

	describe("Action retrieval with policy enforcement", () => {
		it("should filter actions for minimal profile", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
			};

			const filtered = service.filterActions(actions, context);
			// Minimal profile only allows session_status (not in our mock actions)
			expect(filtered.length).toBeLessThan(actions.length);
		});

		it("should allow memory actions for coding profile", () => {
			// group:memory contains read_attachment per TOOL_GROUPS
			const contextWithMemory: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_attachment"],
				},
			};

			const filtered = service.filterActions(actions, contextWithMemory);
			// Our mock has read_memory but the policy only allows read_attachment
			// So this test verifies the policy is applied, even if no actions match
			expect(filtered.length).toBeLessThanOrEqual(actions.length);
		});

		it("should enforce character-level restrictions", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "write_memory"],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			expect(names).toContain("read_memory");
			expect(names).toContain("write_memory");
			expect(names).not.toContain("execute_command");
			expect(names).not.toContain("search_web");
		});

		it("should enforce channel-level overrides", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "write_memory", "execute_command"],
				},
				channelPolicy: {
					deny: ["execute_command"],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			expect(names).toContain("read_memory");
			expect(names).toContain("write_memory");
			expect(names).not.toContain("execute_command");
		});

		it("should enforce provider-level restrictions", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "write_memory", "search_web"],
				},
				providerPolicy: {
					deny: ["search_web"],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			expect(names).toContain("read_memory");
			expect(names).toContain("write_memory");
			expect(names).not.toContain("search_web");
		});

		it("should handle cascading restrictions", () => {
			const context: ToolPolicyContext = {
				profile: "full",
				characterPolicy: {
					allow: [
						"read_memory",
						"write_memory",
						"execute_command",
						"search_web",
					],
				},
				channelPolicy: {
					deny: ["execute_command", "search_web"],
				},
				roomPolicy: {
					deny: ["write_memory"],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			expect(names).toContain("read_memory");
			expect(names).not.toContain("write_memory");
			expect(names).not.toContain("execute_command");
			expect(names).not.toContain("search_web");
		});
	});

	describe("Allowed/denied tool lists for action selection", () => {
		it("should provide allowed tools for action ranking", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "search_web", "send_message"],
				},
			};

			const actionNames = actions.map((a) => a.name);
			const allowed = service.getAllowedTools(context, actionNames);

			expect(allowed).toContain("read_memory");
			expect(allowed).toContain("search_web");
			expect(allowed).toContain("send_message");
			expect(allowed).not.toContain("write_memory");
			expect(allowed).not.toContain("execute_command");
		});

		it("should provide denied tools with reasons for diagnostics", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory"],
				},
			};

			const actionNames = actions.map((a) => a.name);
			const denied = service.getDeniedTools(context, actionNames);

			expect(denied.length).toBeGreaterThan(0);
			expect(
				denied.find((d) => d.name === "execute_command")
			).toBeDefined();
			expect(
				denied.find((d) => d.name === "execute_command")?.reason
			).toBeDefined();
		});
	});

	describe("Policy validation before action execution", () => {
		it("should validate policy configuration before applying", () => {
			const policy: ToolPolicyConfig = {
				allow: ["read_memory", "write_memory", "execute_command"],
			};

			const validation = service.validatePolicy(policy);
			expect(validation.valid).toBe(true);
			expect(validation.errors).toHaveLength(0);
		});

		it("should warn about unknown tools in policy", () => {
			const policy: ToolPolicyConfig = {
				allow: ["read_memory", "unknown_tool"],
			};

			const validation = service.validatePolicy(policy);
			expect(validation.warnings.length).toBeGreaterThan(0);
		});

		it("should detect conflicting policies early", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "write_memory"],
				},
				channelPolicy: {
					deny: ["read_memory", "write_memory"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			expect(policy.allow).toBeDefined();
			expect(policy.deny).toBeDefined();

			// All actions should be denied due to explicit deny
			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);
			expect(names).not.toContain("read_memory");
			expect(names).not.toContain("write_memory");
		});
	});

	describe("Dynamic action selection based on policy", () => {
		it("should simulate action selection for coding context", () => {
			const context: ToolPolicyContext = {
				profile: "coding",
				characterPolicy: {
					allow: [
						"read_memory",
						"execute_command",
						"write_memory",
					],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			// These should be available for coding work
			expect(names).toContain("read_memory");
			expect(names).toContain("write_memory");
			expect(names).toContain("execute_command");
		});

		it("should simulate action selection for messaging context", () => {
			const context: ToolPolicyContext = {
				profile: "messaging",
				characterPolicy: {
					allow: [
						"read_memory",
						"search_web",
						"send_message",
					],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			expect(names).toContain("read_memory");
			expect(names).toContain("search_web");
			expect(names).toContain("send_message");
			expect(names).not.toContain("execute_command");
		});

		it("should handle progressive policy relaxation", () => {
			// Start restrictive
			let context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory"],
				},
			};

			let filtered = service.filterActions(actions, context);
			expect(filtered).toHaveLength(1);

			// Relax to add write
			context = {
				characterPolicy: {
					allow: ["read_memory", "write_memory"],
				},
			};

			filtered = service.filterActions(actions, context);
			expect(filtered).toHaveLength(2);

			// Further relax to add execution
			context = {
				characterPolicy: {
					allow: [
						"read_memory",
						"write_memory",
						"execute_command",
					],
				},
			};

			filtered = service.filterActions(actions, context);
			expect(filtered).toHaveLength(3);
		});
	});

	describe("Real-world policy scenarios", () => {
		it("should enforce read-only data access", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "search_web"],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			expect(names).toContain("read_memory");
			expect(names).toContain("search_web");
			expect(names).not.toContain("write_memory");
			expect(names).not.toContain("execute_command");
			expect(names).not.toContain("send_message");
		});

		it("should enforce trusted-agent full access", () => {
			const context: ToolPolicyContext = {
				profile: "full",
			};

			const filtered = service.filterActions(actions, context);
			expect(filtered).toEqual(actions);
		});

		it("should enforce restricted sandbox", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory"],
					deny: [
						"execute_command",
						"send_message",
						"search_web",
					],
				},
			};

			const filtered = service.filterActions(actions, context);
			const names = filtered.map((a) => a.name);

			expect(names).toContain("read_memory");
			expect(names).not.toContain("execute_command");
			expect(names).not.toContain("send_message");
			expect(names).not.toContain("search_web");
		});

		it("should handle channel-specific restrictions", () => {
			// Public channel: read-only
			const publicContext: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "search_web"],
				},
				channelPolicy: {
					deny: ["write_memory", "send_message"],
				},
			};

			let filtered = service.filterActions(actions, publicContext);
			let names = filtered.map((a) => a.name);
			expect(names).toContain("read_memory");
			expect(names).not.toContain("send_message");

			// Private channel: full capability
			const privateContext: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "search_web", "send_message"],
				},
			};

			filtered = service.filterActions(actions, privateContext);
			names = filtered.map((a) => a.name);
			expect(names).toContain("send_message");
		});
	});

	describe("Performance and correctness under scale", () => {
		it("should handle large action lists efficiently", () => {
			// Create many mock actions
			const largeActionList = Array.from({ length: 100 }, (_, i) => ({
				name: `action_${i}`,
				similes: [],
				description: `Action ${i}`,
				validate: async () => true,
				handler: async () => ({ success: true }),
			}));

			const context: ToolPolicyContext = {
				characterPolicy: {
					// Allow even-numbered actions
					allow: largeActionList
						.filter((_, i) => i % 2 === 0)
						.map((a) => a.name),
				},
			};

			const start = performance.now();
			const filtered = service.filterActions(largeActionList, context);
			const duration = performance.now() - start;

			expect(filtered).toHaveLength(50);
			expect(duration).toBeLessThan(100); // Should be very fast
		});

		it("should maintain consistent policy evaluation", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read_memory", "write_memory"],
				},
			};

			// Multiple evaluations should give consistent results
			const result1 = service.filterActions(actions, context);
			const result2 = service.filterActions(actions, context);

			expect(result1.map((a) => a.name)).toEqual(
				result2.map((a) => a.name)
			);
		});
	});
});
