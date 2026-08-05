/** Verifies loaded skills contribute commands without a delayed retry timer. */
import type { CommandRegistryService, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { registerLoadedSkillCommands } from "./commands";
import {
	AgentSkillsPluginLifecycleService,
	disposeAgentSkillsPlugin,
	initializeAgentSkillsPlugin,
} from "./init";
import { agentSkillsPlugin } from "./plugin";
import type { AgentSkillsService } from "./services/skills";

describe("registerLoadedSkillCommands", () => {
	it("registers every loaded skill on the runtime command service", () => {
		const register = vi.fn();
		const runtime = {
			getService: vi.fn(() => ({ register }) as unknown as CommandRegistryService),
		} as unknown as IAgentRuntime;
		const service = {
			getLoadedSkills: () => [
				{ slug: "Web-Search", description: "Search the web" },
				{ slug: "calendar", description: "Manage calendar events" },
			],
		} as unknown as AgentSkillsService;

		expect(registerLoadedSkillCommands(runtime, service)).toBe(2);
		expect(register).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				key: "skill-web-search",
				textAliases: ["/web-search"],
			}),
		);
		expect(register).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ key: "skill-calendar" }),
		);
	});

	it("is a no-op when the commands plugin is absent", () => {
		const runtime = {
			getService: vi.fn(() => null),
		} as unknown as IAgentRuntime;
		const service = {
			getLoadedSkills: () => [{ slug: "calendar", description: "Calendar" }],
		} as unknown as AgentSkillsService;

		expect(registerLoadedSkillCommands(runtime, service)).toBe(0);
	});
});

describe("agent skills command-service readiness", () => {
	it("uses a post-registration lifecycle service instead of awaiting services in plugin init", () => {
		expect(agentSkillsPlugin.init).toBeUndefined();
		expect(agentSkillsPlugin.dependencies).toContain("@elizaos/plugin-commands");
		expect(agentSkillsPlugin.chatPreHandlers ?? []).toEqual([]);
		expect(agentSkillsPlugin.services).toContain(
			AgentSkillsPluginLifecycleService,
		);
	});

	it("waits for the real commands service before registering slash commands", async () => {
		const register = vi.fn();
		const commands = { register } as unknown as CommandRegistryService;
		const service = {
			getLoadedSkills: () => [
				{ slug: "calendar", description: "Manage calendar events" },
			],
			getCatalogStats: () => ({
				loaded: 1,
				total: 1,
				storageType: "memory",
			}),
		} as unknown as AgentSkillsService;
		let resolveCommands: ((value: CommandRegistryService) => void) | undefined;
		const commandsReady = new Promise<CommandRegistryService>((resolve) => {
			resolveCommands = resolve;
		});
		const runtime = {
			getServiceLoadPromise: vi.fn((name: string) =>
				name === "AGENT_SKILLS_SERVICE"
					? Promise.resolve(service)
					: commandsReady,
			),
			logger: { info: vi.fn(), error: vi.fn() },
		} as unknown as IAgentRuntime;

		const init = initializeAgentSkillsPlugin(runtime);
		await Promise.resolve();
		expect(register).not.toHaveBeenCalled();

		resolveCommands?.(commands);
		await init;

		expect(register).toHaveBeenCalledWith(
			expect.objectContaining({ key: "skill-calendar" }),
		);
		disposeAgentSkillsPlugin(runtime);
	});

	it("keeps periodic catalog work isolated between runtimes", async () => {
		vi.useFakeTimers();
		const buildRuntime = () => {
			const syncCatalog = vi.fn(async () => ({ updated: 0, added: 0 }));
			const service = {
				getLoadedSkills: () => [],
				getCatalogStats: () => ({
					loaded: 0,
					total: 0,
					storageType: "memory",
				}),
				syncCatalog,
			} as unknown as AgentSkillsService;
			const commands = {
				register: vi.fn(),
			} as unknown as CommandRegistryService;
			const runtime = {
				getServiceLoadPromise: vi.fn((name: string) =>
					Promise.resolve(
						name === "AGENT_SKILLS_SERVICE" ? service : commands,
					),
				),
				getService: vi.fn(() => service),
				logger: { info: vi.fn(), warn: vi.fn() },
				reportError: vi.fn(),
			} as unknown as IAgentRuntime;
			return { runtime, syncCatalog };
		};

		const first = buildRuntime();
		const second = buildRuntime();
		try {
			await Promise.all([
				initializeAgentSkillsPlugin(first.runtime),
				initializeAgentSkillsPlugin(second.runtime),
			]);
			disposeAgentSkillsPlugin(first.runtime);
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

			expect(first.syncCatalog).not.toHaveBeenCalled();
			expect(second.syncCatalog).toHaveBeenCalledOnce();
		} finally {
			disposeAgentSkillsPlugin(first.runtime);
			disposeAgentSkillsPlugin(second.runtime);
			vi.useRealTimers();
		}
	});
});
