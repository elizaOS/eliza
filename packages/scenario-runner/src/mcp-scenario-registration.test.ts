/**
 * Regression coverage for deterministic-mcp-actions-routes' seed-time MCP
 * registration contract.
 *
 * The scenario declares "@elizaos/plugin-mcp" under requires.plugins — a
 * real, resolvable package the batch-level factory imports and registers
 * before the scenario runs (see registerScenarioRequiredPlugins) — never
 * under requires.fixturePlugins (which is reserved for scenario-local
 * fixture plugins only the scenario's own seed can register; see
 * resolveRequiredFixturePlugins / commit 2a589d97652).
 *
 * The scenario's own seed (seedMcp in
 * test/scenarios/deterministic-mcp-actions-routes.scenario.ts) self-heals by
 * checking `runtime.plugins.some((p) => p.name === mcpPlugin.name)` before
 * calling registerPlugin again, then reads `scenarioMcpService.getServers()`
 * straight off the instance it just started with `await McpService.start()`.
 * If the real plugin-mcp package's exported name ever drifts from what
 * pluginNameAliases("@elizaos/plugin-mcp") recognizes, or the real
 * McpService ever stops finding its configured "mcp" setting, the seed fails
 * with exactly the defect's signature: "MCP server scenario_mcp was not
 * registered".
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import mcpPlugin from "../../../plugins/plugin-mcp/src/index.ts";
import { McpService } from "../../../plugins/plugin-mcp/src/service.ts";
import mcpScenario from "../test/scenarios/deterministic-mcp-actions-routes.scenario.ts";
import {
  pluginMatchesScenarioPackage,
  registerScenarioRequiredPlugins,
  resolveRequiredFixturePlugins,
  resolveRequiredPluginPackages,
} from "./required-plugins.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../test/fixtures/mcp-stdio-fixture.mjs");
const MCP_SERVER_NAME = "scenario_mcp";
const MCP_PACKAGE = "@elizaos/plugin-mcp";

/**
 * Mirrors AgentRuntime.getSetting()'s real behavior: it round-trips string,
 * boolean, and number values but falls through every typeof branch to
 * `return null` for an object/array value (packages/core/src/runtime.ts,
 * getSetting()). McpService's getConfiguredMcpSettings() only survives that
 * because it falls back to reading `runtime.character.settings.mcp`
 * directly. This fake stays faithful to both halves of that contract so the
 * "connects the real stdio fixture" test below actually exercises the code
 * path the real scenario depends on, not a more forgiving stand-in.
 */
function createFakeRuntime(mcpSettings: unknown): AgentRuntime {
  const settings: Record<string, unknown> = { mcp: mcpSettings };
  return {
    getSetting: (key: string) => {
      const value = settings[key];
      return typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number"
        ? value
        : null;
    },
    character: { settings },
    reportError: vi.fn(),
  } as unknown as AgentRuntime;
}

describe("deterministic-mcp-actions-routes MCP plugin registration contract", () => {
  it("declares @elizaos/plugin-mcp as a resolvable required plugin, not a fixture plugin", () => {
    expect(resolveRequiredPluginPackages(mcpScenario)).toContain(MCP_PACKAGE);
    expect(resolveRequiredFixturePlugins(mcpScenario)).not.toContain(
      MCP_PACKAGE,
    );
  });

  it("resolves the real plugin-mcp package name to something the scenario's own registration guard recognizes", () => {
    // Guards seedMcp's `runtime.plugins.some((p) => p.name === mcpPlugin.name)`
    // self-heal check: it only skips re-registering when this alias match holds.
    expect(
      pluginMatchesScenarioPackage({ name: mcpPlugin.name }, MCP_PACKAGE),
    ).toBe(true);
  });

  it("registers the real @elizaos/plugin-mcp package before the scenario runs, under the name the seed checks for", async () => {
    const plugins: Plugin[] = [];
    const registerPlugin = vi.fn(async (plugin: Plugin) => {
      plugins.push(plugin);
    });
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(runtime, [MCP_PACKAGE], "simulated"),
    ).resolves.toEqual([MCP_PACKAGE]);
    expect(registerPlugin).toHaveBeenCalledOnce();
    expect(plugins[0]?.name).toBe(mcpPlugin.name);
  });

  it("connects the real stdio fixture and reports scenario_mcp in getServers() — the exact check the seed performs", async () => {
    const runtime = createFakeRuntime({
      servers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: "node",
          args: [fixturePath],
          timeoutInMillis: 5_000,
        },
      },
    });

    const service = await McpService.start(runtime);
    try {
      const server = service
        .getServers()
        .find((candidate) => candidate.name === MCP_SERVER_NAME);
      expect(server).toBeDefined();
      expect(server?.status).toBe("connected");
      expect(server?.tools?.length ?? 0).toBe(1);
      expect(server?.resources?.length ?? 0).toBe(1);
    } finally {
      await service.stop();
    }
  }, 15_000);
});
