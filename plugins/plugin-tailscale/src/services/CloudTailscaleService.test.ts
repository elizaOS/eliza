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
  it("rejects invalid runtime ports before cloud provisioning", async () => {
    const fetchMock = vi.fn();
    const service = new CloudTailscaleService(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "eliza_test",
      }),
      {
        fetch: fetchMock,
        cliRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await expect(service.startTunnel(Number.NaN)).rejects.toThrow(
      "Invalid port number",
    );
    await expect(service.startTunnel(1.5)).rejects.toThrow(
      "Invalid port number",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  it("uses background funnel mode when configured", async () => {
    const cliCalls: Array<{ cmd: string; args: string[] }> = [];
    const service = new CloudTailscaleService(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "eliza_test",
        ELIZAOS_CLOUD_BASE_URL: "https://api.elizacloud.ai/api/v1",
        TAILSCALE_FUNNEL: "true",
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
          }),
          text: async () => "",
        }),
        cliRunner: async (cmd, args) => {
          cliCalls.push({ cmd, args });
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    await service.startTunnel(3000);

    expect(cliCalls[1]).toEqual({
      cmd: "tailscale",
      args: ["funnel", "--bg", "3000"],
    });
  });

  it("uses account-specific cloud credentials and trims trailing base URL slashes", async () => {
    const fetchCalls: Array<{ url: string; auth: string; body: unknown }> = [];
    const service = new CloudTailscaleService(
      runtime({
        TAILSCALE_ACCOUNTS: JSON.stringify({
          cloud: {
            tags: ["tag:cloud"],
            cloudApiKey: "account-key",
            cloudBaseUrl: "https://cloud.example.test/api/v1///",
            authKeyExpirySeconds: 90,
          },
        }),
        ELIZAOS_CLOUD_API_KEY: "runtime-key",
      }),
      {
        fetch: async (url, init) => {
          fetchCalls.push({
            url,
            auth: init.headers.Authorization,
            body: JSON.parse(init.body) as unknown,
          });
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              authKey: "hskey-auth-test",
              tailnet: "https://headscale.example.test",
              magicDnsName: "account-node.example.test",
            }),
            text: async () => "",
          };
        },
        cliRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await expect(
      service.startTunnel(3000, { accountId: "cloud" }),
    ).resolves.toBe("https://account-node.example.test");
    expect(fetchCalls).toEqual([
      {
        url: "https://cloud.example.test/api/v1/apis/tunnels/tailscale/auth-key",
        auth: "Bearer account-key",
        body: { tags: ["tag:cloud"], expirySeconds: 90 },
      },
    ]);
  });

  it("rejects malformed cloud auth-key responses before joining the tailnet", async () => {
    const cliRunner = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const service = new CloudTailscaleService(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "eliza_test",
      }),
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ authKey: "missing-magic-dns" }),
          text: async () => "",
        }),
        cliRunner,
      },
    );

    await expect(service.startTunnel(3000)).rejects.toThrow(
      "Cloud Tailscale response malformed",
    );
    expect(cliRunner).not.toHaveBeenCalled();
    expect(service.isActive()).toBe(false);
  });

  it("includes bounded cloud error text and skips CLI calls on provisioning failure", async () => {
    const cliRunner = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const service = new CloudTailscaleService(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "eliza_test",
      }),
      {
        fetch: async () => ({
          ok: false,
          status: 402,
          statusText: "Payment Required",
          json: async () => ({}),
          text: async () => "billing ".repeat(200),
        }),
        cliRunner,
      },
    );

    await expect(service.startTunnel(3000)).rejects.toThrow(
      /Cloud Tailscale auth-key mint failed \(402 Payment Required\): billing/,
    );
    expect(cliRunner).not.toHaveBeenCalled();
  });

  it("logs out when serve setup fails after joining the tailnet", async () => {
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
          }),
          text: async () => "",
        }),
        cliRunner: async (cmd, args) => {
          cliCalls.push({ cmd, args });
          if (args[0] === "serve" && args[1] === "--bg") {
            return { code: 1, stdout: "", stderr: "serve failed" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    await expect(service.startTunnel(3000)).rejects.toThrow("serve failed");

    expect(cliCalls).toContainEqual({
      cmd: "tailscale",
      args: ["serve", "reset"],
    });
    expect(cliCalls).toContainEqual({
      cmd: "tailscale",
      args: ["funnel", "reset"],
    });
    expect(cliCalls).toContainEqual({
      cmd: "tailscale",
      args: ["logout"],
    });
    expect(service.isActive()).toBe(false);
  });
});
