import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CloudTailscaleService } from "./CloudTailscaleService";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    character: {},
    getSetting: vi.fn((key: string) => {
      const value = settings[key];
      return typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
        ? value
        : null;
    }),
  });
}

describe("CloudTailscaleService", () => {
  it("joins Headscale with the returned login server and hostname", async () => {
    const cliCalls: Array<{ cmd: string; args: string[] }> = [];
    const service = new CloudTailscaleService(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "eliza_test",
        ELIZAOS_CLOUD_BASE_URL: "https://api.elizacloud.ai/api/v1",
      }),
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            authKey: "hskey-auth-test",
            tailnet: "https://headscale.elizacloud.ai",
            loginServer: "https://headscale.elizacloud.ai",
            hostname: "eliza-test-session",
            magicDnsName: "eliza-test-session.tunnel.elizacloud.ai",
            billing: {
              model: "on_demand",
              unit: "tunnel_auth_key",
              charged: true,
              amountUsd: 0.01,
              subscription: false,
            },
          }),
          text: async () => "",
        }),
        cliRunner: async (cmd, args) => {
          cliCalls.push({ cmd, args });
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    await expect(service.startTunnel(3000)).resolves.toBe(
      "https://eliza-test-session.tunnel.elizacloud.ai",
    );
    expect(cliCalls[0]).toEqual({
      cmd: "tailscale",
      args: [
        "up",
        "--auth-key=hskey-auth-test",
        "--login-server=https://headscale.elizacloud.ai",
        "--hostname=eliza-test-session",
      ],
    });
    expect(cliCalls[1]).toEqual({
      cmd: "tailscale",
      args: ["serve", "--bg", "--https=443", "localhost:3000"],
    });
    expect(service.getLastProvisioningBilling()).toEqual({
      model: "on_demand",
      unit: "tunnel_auth_key",
      charged: true,
      amountUsd: 0.01,
      subscription: false,
    });
  });
});
