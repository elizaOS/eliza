/**
 * Verifies the deterministic MCP scenario's package-registration contract.
 * The integration-backed harness registers required plugins through the
 * scenario runner, starts the real MCP service with a stdio fixture, and
 * exercises its tool and resource surfaces. Required package plugins must be
 * available before scenario seeding while fixture-only plugins remain local.
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
const MCP_SERVER_ENV_PATTERN = /^MCP_SERVER_.+_(?:URL|TYPE)$/;

async function withoutAmbientMcpServers<T>(run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!MCP_SERVER_ENV_PATTERN.test(key) || value === undefined) continue;
    saved.set(key, value);
    delete process.env[key];
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (MCP_SERVER_ENV_PATTERN.test(key)) delete process.env[key];
    }
    for (const [key, value] of saved) process.env[key] = value;
  }
}

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

  it("connects only the real stdio fixture and exercises its tool and resource", async () => {
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

    const intruderUrlKey = "MCP_SERVER_REGISTRATION_TEST_INTRUDER_URL";
    const intruderTypeKey = "MCP_SERVER_REGISTRATION_TEST_INTRUDER_TYPE";
    const priorIntruderUrl = process.env[intruderUrlKey];
    const priorIntruderType = process.env[intruderTypeKey];
    process.env[intruderUrlKey] = "http://127.0.0.1:9/mcp";
    process.env[intruderTypeKey] = "sse";
    try {
      await withoutAmbientMcpServers(async () => {
        const service = await McpService.start(runtime);
        try {
          expect(service.getServers().map((server) => server.name)).toEqual([
            MCP_SERVER_NAME,
          ]);
          const server = service.getServers()[0];
          expect(server?.status).toBe("connected");
          expect(server?.tools?.map((tool) => tool.name)).toEqual([
            "echo_code",
          ]);
          expect(server?.resources?.map((resource) => resource.uri)).toEqual([
            "fixture://mcp-note",
          ]);

          await expect(
            service.callTool(MCP_SERVER_NAME, "echo_code", {
              code: "registration-contract",
            }),
          ).resolves.toMatchObject({
            content: [
              { type: "text", text: "mcp-tool-echo:registration-contract" },
            ],
          });
          await expect(
            service.readResource(MCP_SERVER_NAME, "fixture://mcp-note"),
          ).resolves.toMatchObject({
            contents: [
              {
                uri: "fixture://mcp-note",
                mimeType: "text/plain",
                text: "mcp-resource-note:alpha-42",
              },
            ],
          });
        } finally {
          await service.stop();
        }
      });
      expect(process.env[intruderUrlKey]).toBe("http://127.0.0.1:9/mcp");
      expect(process.env[intruderTypeKey]).toBe("sse");
    } finally {
      if (priorIntruderUrl === undefined) delete process.env[intruderUrlKey];
      else process.env[intruderUrlKey] = priorIntruderUrl;
      if (priorIntruderType === undefined) delete process.env[intruderTypeKey];
      else process.env[intruderTypeKey] = priorIntruderType;
    }
  }, 15_000);
});
