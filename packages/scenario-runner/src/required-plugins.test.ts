/** Tests declared production-plugin resolution and pre-initialization runtime registration. */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertSharedRuntimePluginBatchSafe,
  registerScenarioRequiredPlugins,
} from "./required-plugins.ts";

describe("scenario required plugin registration", () => {
  it("loads and registers Maps for a simulated live-model runtime", async () => {
    const plugins: Plugin[] = [];
    const registerPlugin = vi.fn(async (plugin: Plugin) => {
      plugins.push(plugin);
    });
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(
        runtime,
        ["@elizaos/plugin-maps"],
        "simulated",
      ),
    ).resolves.toEqual(["@elizaos/plugin-maps"]);
    expect(registerPlugin).toHaveBeenCalledOnce();
    expect(plugins.map((plugin) => plugin.name)).toEqual(["maps"]);
    expect(plugins[0]?.actions?.map((action) => action.name)).toContain(
      "MAPS_SAVE",
    );
  });

  it("does not register an already-present declared plugin twice", async () => {
    const plugins: Plugin[] = [
      { name: "maps", description: "Already registered Maps", actions: [] },
    ];
    const registerPlugin = vi.fn(async (_plugin: Plugin) => undefined);
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await registerScenarioRequiredPlugins(
      runtime,
      ["@elizaos/plugin-maps"],
      "simulated",
    );
    expect(registerPlugin).not.toHaveBeenCalled();
  });
});

describe("shared runtime plugin safety", () => {
  const scenario = (id: string, plugins: string[]) =>
    ({
      id,
      title: id,
      domain: "meetings",
      turns: [],
      requires: { plugins },
    }) as const;

  it("accepts a dependency-homogeneous meetings test batch", () => {
    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("mock-a", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
        scenario("mock-b", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
      ]),
    ).not.toThrow();
  });

  it("rejects a shared mock and production meetings batch", () => {
    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("mock", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
        scenario("live", ["@elizaos/plugin-meetings"]),
      ]),
    ).toThrow(/unsafe shared meetings batch.*mock.*live/u);
  });

  it("rejects an undeclared action scenario that could inherit ambient meeting test support", () => {
    const undeclaredActionScenario = {
      id: "ambient-false-green",
      title: "Ambient false green",
      domain: "other",
      turns: [
        {
          kind: "action",
          name: "invokes meetings without declaring its dependency",
          actionName: "JOIN_MEETING",
          parameters: { meetingUrl: "https://meet.google.com/abc-defg-hij" },
        },
      ],
    } as const;

    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("declared-mock", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
        undeclaredActionScenario,
      ]),
    ).toThrow(
      /every scenario sharing that runtime must explicitly declare.*ambient-false-green/u,
    );
  });

  it("rejects test support without its production plugin", () => {
    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("orphan", ["@elizaos/plugin-meetings/test-support"]),
      ]),
    ).toThrow(/declares meetings test support without/u);
  });
});
