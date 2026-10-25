/** ACP switches saved in Settings or the character file take effect on a real runtime. */
import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.ts";

type AcpSettingsView = {
  defaultApprovalPreset: string;
  warmSpawnEnabled: boolean;
  shouldDisableTerminalCapability(): boolean;
};

function serviceWith(settings: Record<string, string>) {
  // AgentRuntime.getSetting returns "true"/"false" as booleans, as in the app.
  const runtime = new AgentRuntime({
    character: {
      name: "AcpSettings",
      settings: {
        ELIZA_ACP_TRANSPORT: "native",
        ELIZA_ACP_DEFAULT_AGENT: "elizaos",
        ...settings,
      },
    },
  });
  return new AcpService(runtime) as unknown as AcpSettingsView;
}

describe("AcpService boolean settings", () => {
  it("applies switches turned on", () => {
    const service = serviceWith({
      ACPX_NO_TERMINAL: "true",
      ACPX_APPROVE_ALL: "true",
      ELIZA_ACP_WARM_SPAWN: "true",
    });
    expect(service.shouldDisableTerminalCapability()).toBe(true);
    // "approve-all" is stored under its canonical name, "permissive".
    expect(service.defaultApprovalPreset).toBe("permissive");
    expect(service.warmSpawnEnabled).toBe(true);
  });

  it("applies switches turned off", () => {
    const service = serviceWith({
      ACPX_NO_TERMINAL: "false",
      ACPX_APPROVE_ALL: "false",
      ELIZA_ACP_WARM_SPAWN: "false",
    });
    expect(service.shouldDisableTerminalCapability()).toBe(false);
    expect(service.defaultApprovalPreset).not.toBe("permissive");
    expect(service.warmSpawnEnabled).toBe(false);
  });
});
