import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { CloudTailscaleService } from "../../services/CloudTailscaleService";

interface RuntimeSettings {
  [key: string]: string | undefined;
}

function makeRuntime(settings: RuntimeSettings = {}): IAgentRuntime {
  const defaults: RuntimeSettings = {
    ELIZAOS_CLOUD_API_KEY: "test-key",
    ELIZAOS_CLOUD_BASE_URL: "https://cloud.test/api/v1",
    ...settings,
  };
  const runtime = {
    agentId: "agent-test",
    getSetting: (key: string) => defaults[key],
  };
  return runtime as unknown as IAgentRuntime;
}

interface CliCall {
  cmd: string;
  args: string[];
}

function makeCliRunner(calls: CliCall[]) {
  return async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("CloudTailscaleService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let cliCalls: CliCall[];

  beforeEach(() => {
    fetchMock = vi.fn();
    cliCalls = [];
  });

  function makeService(runtime: IAgentRuntime) {
    return new CloudTailscaleService(runtime, {
      fetch: fetchMock as unknown as typeof fetch,
      cliRunner: makeCliRunner(cliCalls),
    });
  }

  it("mints an auth key, joins tailnet, and runs serve", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authKey: "tskey-auth-xxx",
          tailnet: "example.ts.net",
          magicDnsName: "eliza-1234.example.ts.net",
        }),
        { status: 200 },
      ),
    );

    const service = makeService(makeRuntime());
    const url = await service.startTunnel(8080);

    expect(url).toBe("https://eliza-1234.example.ts.net");
    expect(service.isActive()).toBe(true);
    expect(service.getStatus().provider).toBe("tailscale");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] ?? [];
    const requestUrl = firstCall[0];
    const init = firstCall[1] as RequestInit | undefined;
    expect(String(requestUrl)).toContain("/apis/tunnels/tailscale/auth-key");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("tag:eliza-tunnel");

    expect(cliCalls).toEqual([
      { cmd: "tailscale", args: ["up", "--auth-key=tskey-auth-xxx"] },
      {
        cmd: "tailscale",
        args: ["serve", "--bg", "--https=443", "localhost:8080"],
      },
    ]);
  });

  it("throws when cloud responds with non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 503 }));
    const service = makeService(makeRuntime());

    await expect(service.startTunnel(8080)).rejects.toThrow(/503/);
    expect(service.isActive()).toBe(false);
  });

  it("throws when cloud response is malformed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ wat: "no" }), { status: 200 }),
    );
    const service = makeService(makeRuntime());

    await expect(service.startTunnel(8080)).rejects.toThrow(/malformed/);
  });

  it("refuses to start without a port", async () => {
    const service = makeService(makeRuntime());
    const result = await service.startTunnel();
    expect(result).toBeUndefined();
    expect(service.isActive()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when cloud API key is missing", async () => {
    const runtime = makeRuntime({ ELIZAOS_CLOUD_API_KEY: undefined });
    const service = makeService(runtime);

    await expect(service.startTunnel(8080)).rejects.toThrow(
      /ELIZAOS_CLOUD_API_KEY/,
    );
  });

  it("uses funnel when TAILSCALE_FUNNEL=true", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authKey: "tskey-auth-xxx",
          tailnet: "example.ts.net",
          magicDnsName: "eliza-1234.example.ts.net",
        }),
        { status: 200 },
      ),
    );

    const service = makeService(makeRuntime({ TAILSCALE_FUNNEL: "true" }));
    await service.startTunnel(8080);

    expect(cliCalls[1]).toEqual({ cmd: "tailscale", args: ["funnel", "8080"] });
  });

  it("logs out and resets serve/funnel on stopTunnel", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authKey: "tskey-auth-xxx",
          tailnet: "example.ts.net",
          magicDnsName: "eliza-1234.example.ts.net",
        }),
        { status: 200 },
      ),
    );

    const service = makeService(makeRuntime());
    await service.startTunnel(8080);
    await service.stopTunnel();

    expect(cliCalls.map((c) => c.args.join(" "))).toEqual([
      "up --auth-key=tskey-auth-xxx",
      "serve --bg --https=443 localhost:8080",
      "serve reset",
      "funnel reset",
      "logout",
    ]);
    expect(service.isActive()).toBe(false);
  });
});
