import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { preflightCodingDispatch } from "./scaffold-env.js";
import { runViewsEdit } from "./views-edit.js";
import { locatePluginSourceDir } from "./views-plugin-source.js";

vi.mock("./views-plugin-source.js", () => ({
  locatePluginSourceDir: vi.fn(),
}));

describe("verified view authoring admission", () => {
  it.each([null, {}, { verifyPlugin: true }])(
    "rejects an unavailable verifier before resolving editable source (%j)",
    async (service) => {
      const runtime = {
        actions: [{ name: "TASKS_SPAWN_AGENT" }],
        getService: vi.fn(() => service),
        getSetting: () => "configured-backend",
      } as unknown as IAgentRuntime;
      const result = await runViewsEdit({
        runtime,
        message: { content: { text: "Change Notes" } } as Memory,
        options: { target: "notes", intent: "Change the title" },
        views: [
          {
            id: "notes",
            label: "Notes",
            pluginName: "@elizaos/plugin-notes",
            available: true,
          },
        ],
        repoRoot: "/unused",
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain("Plugin verification is unavailable");
      expect(runtime.getService).toHaveBeenCalledWith("app-verification");
      expect(locatePluginSourceDir).not.toHaveBeenCalled();
    },
  );

  it("admits a runtime with the required verifier and coding backend", async () => {
    const runtime = {
      actions: [{ name: "TASKS_SPAWN_AGENT" }],
      getService: () => ({ verifyPlugin: async () => ({ verdict: "pass" }) }),
      getSetting: () => "configured-backend",
    } as unknown as IAgentRuntime;
    expect(await preflightCodingDispatch(runtime)).toEqual({
      ok: true,
      guidance: [],
    });
  });
});
