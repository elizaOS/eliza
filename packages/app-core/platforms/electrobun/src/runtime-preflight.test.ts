/** Verifies desktop runtime recovery against real HTTP health/status responses. */
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  probeExternalAgent,
  resolveDesktopApiRequestToken,
  resolveDesktopRuntimeForBoot,
  resolveQualifiedExternalToken,
} from "./runtime-preflight";

const remoteDeployment = {
  runtime: "remote" as const,
  remoteApiBase: "http://127.0.0.1:2250",
};

type EndpointResponse = {
  status?: number;
  body: string;
  contentType?: string;
  requiredBearer?: string;
  location?: string;
};

function sendResponse(res: ServerResponse, response: EndpointResponse): void {
  res.writeHead(response.status ?? 200, {
    "content-type": response.contentType ?? "application/json",
    ...(response.location ? { location: response.location } : {}),
  });
  res.end(response.body);
}

async function withProbeServer(
  endpoints: Record<string, EndpointResponse>,
  run: (base: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    const endpoint = endpoints[pathname];
    if (
      endpoint?.requiredBearer &&
      req.headers.authorization !== `Bearer ${endpoint.requiredBearer}`
    ) {
      sendResponse(res, { status: 401, body: '{"error":"unauthorized"}' });
      return;
    }
    sendResponse(
      res,
      endpoint ?? { status: 404, body: '{"error":"not_found"}' },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("probe test server did not expose a TCP port");
    }
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const readyElizaEndpoints: Record<string, EndpointResponse> = {
  "/api/health": { body: '{"ready":true}' },
  "/api/status": {
    body: JSON.stringify({
      state: "running",
      agentName: "Eliza",
      canRespond: true,
    }),
  },
};

describe("probeExternalAgent", () => {
  it("accepts a ready Eliza agent through both public contracts", async () => {
    await withProbeServer(readyElizaEndpoints, async (base, requests) => {
      await expect(probeExternalAgent(`${base}/`)).resolves.toBe(true);
      expect(requests).toEqual(["/api/health", "/api/status"]);
    });
  });

  it("authenticates the protected status contract for a persisted agent", async () => {
    await withProbeServer(
      {
        ...readyElizaEndpoints,
        "/api/status": {
          ...readyElizaEndpoints["/api/status"],
          requiredBearer: "remote-secret",
        },
      },
      async (base, requests) => {
        await expect(probeExternalAgent(base, "remote-secret")).resolves.toBe(
          true,
        );
        expect(requests).toEqual(["/api/health", "/api/status"]);
      },
    );
  });

  it("rejects redirects without forwarding the persisted bearer", async () => {
    await withProbeServer(
      { "/redirect-target": readyElizaEndpoints["/api/status"] },
      async (redirectBase, redirectRequests) => {
        await withProbeServer(
          {
            ...readyElizaEndpoints,
            "/api/status": {
              status: 302,
              body: "",
              location: `${redirectBase}/redirect-target`,
            },
          },
          async (base, requests) => {
            await expect(
              probeExternalAgent(base, "remote-secret"),
            ).resolves.toBe(false);
            expect(requests).toEqual(["/api/health", "/api/status"]);
            expect(redirectRequests).toEqual([]);
          },
        );
      },
    );
  });

  it.each([
    [
      "authentication challenge",
      { status: 401, body: '{"error":"unauthorized"}' },
    ],
    ["404", { status: 404, body: '{"error":"not_found"}' }],
    ["wrong-service", { body: '{"ok":true,"service":"nginx"}' }],
    ["malformed", { body: "not-json", contentType: "text/plain" }],
    ["not-ready", { body: '{"ready":false}' }],
  ])("rejects a %s health response", async (_label, health) => {
    await withProbeServer(
      { ...readyElizaEndpoints, "/api/health": health },
      async (base, requests) => {
        await expect(probeExternalAgent(base)).resolves.toBe(false);
        expect(requests).toEqual(["/api/health"]);
      },
    );
  });

  it.each([
    [
      "authentication challenge",
      { status: 401, body: '{"error":"unauthorized"}' },
    ],
    ["404", { status: 404, body: '{"error":"not_found"}' }],
    ["wrong-service", { body: '{"state":"ok","name":"api"}' }],
    ["malformed", { body: "<html>ok</html>", contentType: "text/html" }],
    [
      "not-ready",
      {
        body: JSON.stringify({
          state: "starting",
          agentName: "Eliza",
          canRespond: false,
        }),
      },
    ],
  ])("rejects a %s Eliza status response", async (_label, status) => {
    await withProbeServer(
      { ...readyElizaEndpoints, "/api/status": status },
      async (base, requests) => {
        await expect(probeExternalAgent(base)).resolves.toBe(false);
        expect(requests).toEqual(["/api/health", "/api/status"]);
      },
    );
  });
});

describe("resolveDesktopRuntimeForBoot", () => {
  it("keeps a reachable persisted remote target external", async () => {
    const probe = vi.fn(async () => true);
    const result = await resolveDesktopRuntimeForBoot({
      env: {},
      deployment: remoteDeployment,
      probe,
    });

    expect(result.mode).toBe("external");
    expect(result.externalReachability).toBe("verified");
    expect(result.externalApi.base).toBe("http://127.0.0.1:2250");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("qualifies a configured external bearer against the actual request origin", () => {
    const resolution = {
      mode: "external" as const,
      externalApi: {
        base: "https://remote.example",
        source: "ELIZA_DESKTOP_API_BASE" as const,
        invalidSources: [],
      },
    };

    expect(
      resolveDesktopApiRequestToken({
        resolution,
        targetUrl: "https://remote.example/api/config",
        configuredToken: " remote-secret ",
      }),
    ).toBe("remote-secret");
    for (const targetUrl of [
      "http://127.0.0.1:31337/api/agent/reset",
      "http://localhost:31337/api/config",
      "https://remote.example.evil.test/api/config",
      "not a URL",
    ]) {
      expect(
        resolveDesktopApiRequestToken({
          resolution,
          targetUrl,
          configuredToken: "remote-secret",
        }),
      ).toBeUndefined();
    }
  });

  it("passes only the persisted target token to the readiness probe", async () => {
    const probe = vi.fn(async () => true);
    const result = await resolveDesktopRuntimeForBoot({
      env: {},
      deployment: {
        ...remoteDeployment,
        remoteAccessToken: " remote-secret ",
      },
      probe,
    });

    expect(result.mode).toBe("external");
    expect(result.externalReachability).toBe("verified");
    expect(probe).toHaveBeenCalledWith(
      "http://127.0.0.1:2250",
      "remote-secret",
    );
    expect(
      resolveQualifiedExternalToken(result, "http://127.0.0.1:2250/api/chat"),
    ).toBe("remote-secret");
    expect(
      resolveQualifiedExternalToken(result, "http://127.0.0.1:2251/api/chat"),
    ).toBeUndefined();
    expect(
      resolveDesktopApiRequestToken({
        resolution: result,
        targetUrl: "http://127.0.0.1:2250/api/config",
      }),
    ).toBe("remote-secret");
    expect(
      resolveDesktopApiRequestToken({
        resolution: result,
        targetUrl: "http://127.0.0.1:2251/api/agent/reset",
      }),
    ).toBeUndefined();
    expect(
      resolveDesktopApiRequestToken({
        resolution: result,
        targetUrl: "not a URL",
      }),
    ).toBeUndefined();
  });

  it("carries the qualified bearer from real preflight into a protected application request", async () => {
    await withProbeServer(
      {
        ...readyElizaEndpoints,
        "/api/status": {
          ...readyElizaEndpoints["/api/status"],
          requiredBearer: "remote-secret",
        },
        "/api/application": {
          body: '{"ok":true}',
          requiredBearer: "remote-secret",
        },
      },
      async (base, requests) => {
        const result = await resolveDesktopRuntimeForBoot({
          env: {},
          deployment: {
            runtime: "remote",
            remoteApiBase: base,
            remoteAccessToken: "remote-secret",
          },
        });
        const token = resolveQualifiedExternalToken(
          result,
          `${base}/api/application`,
        );
        const response = await fetch(`${base}/api/application`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        expect(response.status).toBe(200);
        expect(requests).toEqual([
          "/api/health",
          "/api/status",
          "/api/application",
        ]);
      },
    );
  });

  it("recovers an unreachable persisted remote target to embedded local", async () => {
    const result = await resolveDesktopRuntimeForBoot({
      env: {},
      deployment: remoteDeployment,
      probe: async () => false,
    });

    expect(result.mode).toBe("local");
    expect(result.externalApi.base).toBeNull();
  });

  it("qualifies persisted access in a runtime-less external package", async () => {
    const probe = vi.fn(async () => true);
    const result = await resolveDesktopRuntimeForBoot({
      env: { ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: "1" },
      deployment: {
        ...remoteDeployment,
        remoteAccessToken: " remote-secret ",
      },
      probe,
    });

    expect(result.mode).toBe("external");
    expect(result.externalReachability).toBe("verified");
    expect(probe).toHaveBeenCalledWith(
      "http://127.0.0.1:2250",
      "remote-secret",
    );
    expect(
      resolveQualifiedExternalToken(result, "http://127.0.0.1:2250/api/chat"),
    ).toBe("remote-secret");
  });

  it("keeps a failed runtime-less probe external but unavailable", async () => {
    const probe = vi.fn(async () => false);
    const result = await resolveDesktopRuntimeForBoot({
      env: { ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: "1" },
      deployment: {
        ...remoteDeployment,
        remoteAccessToken: " remote-secret ",
      },
      probe,
    });

    expect(result.mode).toBe("external");
    expect(result.externalApi.base).toBe("http://127.0.0.1:2250");
    expect(result.externalReachability).toBe("unavailable");
    expect(result.qualifiedAccess).toBeUndefined();
    expect(probe).toHaveBeenCalledWith(
      "http://127.0.0.1:2250",
      "remote-secret",
    );
    expect(
      resolveQualifiedExternalToken(result, "http://127.0.0.1:2250/api/chat"),
    ).toBeUndefined();
  });

  it("preserves explicit env targets without probing persisted state", async () => {
    const probe = vi.fn(async () => false);
    const result = await resolveDesktopRuntimeForBoot({
      env: { ELIZA_DESKTOP_API_BASE: "http://127.0.0.1:9999" },
      deployment: remoteDeployment,
      probe,
    });

    expect(result.mode).toBe("external");
    expect(result.externalApi.base).toBe("http://127.0.0.1:9999");
    expect(probe).not.toHaveBeenCalled();
  });
});
