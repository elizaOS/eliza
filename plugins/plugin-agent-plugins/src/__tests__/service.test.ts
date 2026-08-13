import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPluginsService } from "../services/agent-plugins";
import { AGENT_SKILLS_SERVICE_TYPE } from "../types";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function mockRuntime(
	settings: Record<string, unknown> = {},
	services: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
		getService: (name: string) => services[name],
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			log: vi.fn(),
			success: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("AgentPluginsService", () => {
	const temps: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	async function tempDir(prefix: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), prefix));
		temps.push(dir);
		return dir;
	}

	it("scans AGENT_PLUGINS_DIR and extra AGENT_PLUGIN_PATHS", async () => {
		const installed = await tempDir("agent-plugins-installed-");
		await cp(join(fixtures, "minimal"), join(installed, "minimal-plugin"), {
			recursive: true,
		});
		const runtime = mockRuntime({
			AGENT_PLUGINS_DIR: installed,
			AGENT_PLUGIN_PATHS: join(fixtures, "full"),
		});
		const service = await AgentPluginsService.start(runtime);
		const names = service.list().map((plugin) => plugin.manifest.name);
		expect(names).toEqual(["full-plugin", "minimal-plugin"]);
		expect(service.get("full-plugin")?.skills).toHaveLength(1);
		expect(service.get("full-plugin")?.mcp.servers).toHaveLength(1);
	});

	it("installFromDirectory copies a valid plugin and rejects duplicates", async () => {
		const installed = await tempDir("agent-plugins-install-");
		const runtime = mockRuntime({ AGENT_PLUGINS_DIR: installed });
		const service = await AgentPluginsService.start(runtime);
		expect(service.list()).toEqual([]);

		const first = await service.installFromDirectory(join(fixtures, "minimal"));
		expect(first.manifest.name).toBe("minimal-plugin");
		expect(service.get("minimal-plugin")?.source).toBe("installed");

		await expect(
			service.installFromDirectory(join(fixtures, "minimal")),
		).rejects.toThrow(/already installed/);

		const again = await service.installFromDirectory(join(fixtures, "minimal"), {
			force: true,
		});
		expect(again.manifest.name).toBe("minimal-plugin");
	});

	it("rejects a remote URL and does not install an invalid plugin", async () => {
		const installed = await tempDir("agent-plugins-url-");
		const service = await AgentPluginsService.start(
			mockRuntime({ AGENT_PLUGINS_DIR: installed }),
		);
		await expect(
			service.installFromDirectory("https://example.com/plugin.tgz"),
		).rejects.toThrow(/Remote URLs/);
		await expect(
			service.installFromDirectory(join(fixtures, "bad-name")),
		).rejects.toThrow(/Invalid Agent Plugin/);
		expect(service.list()).toEqual([]);
	});

	it("uninstall deletes the installed copy only", async () => {
		const installed = await tempDir("agent-plugins-uninstall-");
		const service = await AgentPluginsService.start(
			mockRuntime({ AGENT_PLUGINS_DIR: installed }),
		);
		await service.installFromDirectory(join(fixtures, "minimal"));
		await service.uninstall("minimal-plugin");
		expect(service.get("minimal-plugin")).toBeUndefined();

		const extra = await AgentPluginsService.start(
			mockRuntime({
				AGENT_PLUGINS_DIR: await tempDir("agent-plugins-empty-"),
				AGENT_PLUGIN_PATHS: join(fixtures, "full"),
			}),
		);
		await expect(extra.uninstall("full-plugin")).rejects.toThrow(
			/AGENT_PLUGIN_PATHS/,
		);
		expect(extra.get("full-plugin")).toBeDefined();
	});

	it("bridges discovered skills when AgentSkillsService is present", async () => {
		const addPluginSkillsDir = vi.fn(async () => {});
		const installed = await tempDir("agent-plugins-bridge-");
		const service = await AgentPluginsService.start(
			mockRuntime(
				{
					AGENT_PLUGINS_DIR: installed,
					AGENT_PLUGIN_PATHS: join(fixtures, "full"),
				},
				{ [AGENT_SKILLS_SERVICE_TYPE]: { addPluginSkillsDir } },
			),
		);
		expect(service.get("full-plugin")).toBeDefined();
		expect(addPluginSkillsDir).toHaveBeenCalledTimes(1);
		expect(String(addPluginSkillsDir.mock.calls[0]?.[0])).toContain(
			join("full", "skills"),
		);
	});

	it("does not connect MCP servers unless AGENT_PLUGINS_ENABLE_MCP is true", async () => {
		const connectServer = vi.fn(async () => {});
		const installed = await tempDir("agent-plugins-mcp-");
		await AgentPluginsService.start(
			mockRuntime(
				{
					AGENT_PLUGINS_DIR: installed,
					AGENT_PLUGIN_PATHS: join(fixtures, "full"),
					AGENT_PLUGINS_ENABLE_MCP: false,
				},
				{ mcp: { connectServer } },
			),
		);
		expect(connectServer).not.toHaveBeenCalled();
	});
});
