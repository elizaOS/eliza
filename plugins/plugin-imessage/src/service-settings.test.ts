/**
 * Regression: the Plugins form saves IMESSAGE_POLL_INTERVAL_MS and
 * IMESSAGE_HEARTBEAT_INTERVAL_MS as numbers, because both parameters are
 * declared "number" in agentConfig.pluginParameters. AgentRuntime.getSetting
 * returns a saved number unchanged, so loadSettings must keep it.
 */
import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { IMessageService } from "./service.js";
import type { IMessageSettings } from "./types.js";

describe("iMessage settings saved from the Plugins form", () => {
  it("keeps the poll and heartbeat intervals saved as numbers", () => {
    const runtime = new AgentRuntime({
      character: {
        name: "IMessageSettings",
        bio: [],
        settings: {
          IMESSAGE_POLL_INTERVAL_MS: 1500,
          IMESSAGE_HEARTBEAT_INTERVAL_MS: 900,
        },
      },
      logLevel: "fatal",
      enableAutonomy: false,
    });
    // The real runtime hands a numeric setting back as a number.
    expect(runtime.getSetting("IMESSAGE_POLL_INTERVAL_MS")).toBe(1500);
    expect(runtime.getSetting("IMESSAGE_HEARTBEAT_INTERVAL_MS")).toBe(900);

    const service = new IMessageService(runtime);
    const settings = (
      service as unknown as {
        loadSettings(): IMessageSettings;
      }
    ).loadSettings();

    expect(settings.pollIntervalMs).toBe(1500);
    expect(settings.heartbeatIntervalMs).toBe(900);
  });
});
