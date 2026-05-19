import { CapabilityError, type IAgentRuntime, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type E2BSandboxClient,
  type E2BSandboxFactory,
  E2BSatelliteCapabilityRouterService,
  type E2BSatelliteRunnerConfig,
  resolveE2BSatelliteRunnerConfig,
  type SandboxCommandResult,
  type SandboxEntryInfo,
} from "./e2b-capability-router.ts";

class FakeFiles {
  readonly listCalls: string[] = [];
  readonly readCalls: string[] = [];
  readonly writeCalls: Array<{ path: string; text: string }> = [];

  constructor(private readonly entries: SandboxEntryInfo[] = []) {}

  async list(path: string): Promise<SandboxEntryInfo[]> {
    this.listCalls.push(path);
    return this.entries;
  }

  async read(
    path: string,
    opts?: { format?: "text"; requestTimeoutMs?: number },
  ): Promise<string>;
  async read(
    path: string,
    opts: { format: "bytes"; requestTimeoutMs?: number },
  ): Promise<Uint8Array>;
  async read(
    path: string,
    opts?: { format?: "text" | "bytes"; requestTimeoutMs?: number },
  ): Promise<string | Uint8Array> {
    this.readCalls.push(path);
    if (opts?.format === "bytes") return new TextEncoder().encode("file text");
    return "file text";
  }

  async write(
    path: string,
    data: string,
  ): Promise<{ name: string; path: string; type: SandboxEntryInfo["type"] }> {
    this.writeCalls.push({ path, text: data });
    return { name: path.split("/").pop() ?? path, path, type: FILE_ENTRY };
  }
}

class FakeCommands {
  readonly runCalls: Array<{ cmd: string; cwd?: string }> = [];

  async run(
    cmd: string,
    opts: { cwd?: string } = {},
  ): Promise<SandboxCommandResult> {
    this.runCalls.push({ cmd, cwd: opts.cwd });
    return {
      exitCode: 0,
      stdout: cmd.startsWith("mkdir ") ? "" : `ran ${cmd}\n`,
      stderr: "",
    };
  }
}

class FakeSandbox implements E2BSandboxClient {
  readonly sandboxId = "sbx_test";
  readonly files: FakeFiles;
  readonly commands = new FakeCommands();
  readonly kill = vi.fn(async () => {});

  constructor(entries: SandboxEntryInfo[] = []) {
    this.files = new FakeFiles(entries);
  }
}

class FakeFactory implements E2BSandboxFactory {
  readonly configs: E2BSatelliteRunnerConfig[] = [];

  constructor(readonly sandbox = new FakeSandbox()) {}

  async create(config: E2BSatelliteRunnerConfig): Promise<E2BSandboxClient> {
    this.configs.push(config);
    return this.sandbox;
  }
}

type SatelliteHttpCall = {
  method: string;
  pathname: string;
  authorization: string | null;
  body: unknown;
};

type SatelliteHttpServer = {
  baseUrl: string;
  calls: SatelliteHttpCall[];
  close: () => Promise<void>;
};

type SatelliteRouteContext = {
  request: Request;
  url: URL;
  body: unknown;
  bodyText: string;
};

function replaceGlobalFetch(fetchImpl: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  });
}

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const runtime: Partial<IAgentRuntime> = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "E2B Test" },
    getSetting: (key: string) => settings[key],
    getService: () => null,
  };
  return runtime as IAgentRuntime;
}

function startSatelliteHttpServer(): SatelliteHttpServer {
  const calls: SatelliteHttpCall[] = [];
  const originalFetch = globalThis.fetch;
  const fetchMock: typeof fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const request = new Request(input, init);
      return handleSatelliteHttpRequest(request, calls);
    },
    { preconnect: originalFetch.preconnect },
  );
  replaceGlobalFetch(fetchMock);
  return {
    baseUrl: "https://satellite.test",
    calls,
    close: async () => {
      replaceGlobalFetch(originalFetch);
    },
  };
}

function startElizaCloudProvisioningServer(): SatelliteHttpServer {
  const calls: SatelliteHttpCall[] = [];
  const originalFetch = globalThis.fetch;
  const fetchMock: typeof fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.href === "https://api.elizacloud.ai/api/v1/coding-containers"
      ) {
        const bodyText = await request.text();
        calls.push({
          method: request.method,
          pathname: url.pathname,
          authorization: request.headers.get("authorization"),
          body: parseRequestBody(request, bodyText),
        });
        return jsonResponse(201, {
          success: true,
          data: {
            containerId: "cloud-container-1",
            status: "running",
            agent: "codex",
            workspacePath: "/workspace",
            url: "https://satellite.test",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });
      }
      return handleSatelliteHttpRequest(request, calls);
    },
    { preconnect: originalFetch.preconnect },
  );
  replaceGlobalFetch(fetchMock);
  return {
    baseUrl: "https://api.elizacloud.ai/api/v1",
    calls,
    close: async () => {
      replaceGlobalFetch(originalFetch);
    },
  };
}

async function handleSatelliteHttpRequest(
  request: Request,
  calls: SatelliteHttpCall[],
): Promise<Response> {
  const context = await readSatelliteRouteContext(request);
  recordSatelliteHttpCall(context, calls);
  if (!isAuthorizedSatelliteRequest(request)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  return satelliteRouteResponse(context);
}

async function readSatelliteRouteContext(
  request: Request,
): Promise<SatelliteRouteContext> {
  const url = new URL(request.url);
  const bodyText = methodMayHaveBody(request.method)
    ? await request.text()
    : "";
  return {
    request,
    url,
    bodyText,
    body: parseRequestBody(request, bodyText),
  };
}

function recordSatelliteHttpCall(
  context: SatelliteRouteContext,
  calls: SatelliteHttpCall[],
): void {
  calls.push({
    method: context.request.method,
    pathname: context.url.pathname,
    authorization: context.request.headers.get("authorization"),
    body: context.body,
  });
}

function satelliteRouteResponse(context: SatelliteRouteContext): Response {
  const route = `${context.request.method} ${context.url.pathname}`;
  if (route === "GET /v1/health") {
    return jsonResponse(200, { ok: true });
  }
  if (route === "GET /v1/fs/entries") {
    return satelliteEntriesResponse(context.url);
  }
  if (route === "GET /v1/fs/file") {
    return new Response(`text:${context.url.searchParams.get("path") ?? ""}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  if (route === "PUT /v1/fs/file") {
    const path = context.url.searchParams.get("path") ?? "";
    return jsonResponse(200, {
      path,
      name: path.split("/").pop() ?? path,
      bytesWritten: Buffer.byteLength(context.bodyText, "utf8"),
    });
  }
  if (route === "POST /v1/processes/run") {
    return satelliteProcessRunResponse(context.body);
  }
  return jsonResponse(404, { error: "not found" });
}

function isAuthorizedSatelliteRequest(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  return (
    authorization === "Bearer token" ||
    authorization === "Bearer cloud-key" ||
    Boolean(authorization?.startsWith("Bearer "))
  );
}

function satelliteEntriesResponse(url: URL): Response {
  const path = url.searchParams.get("path") ?? "/workspace";
  return jsonResponse(200, {
    entries: [
      {
        path: `${path}/src`,
        name: "src",
        kind: "directory",
        size: 0,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        path: `${path}/README.md`,
        name: "README.md",
        kind: "file",
        size: 12,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
}

function satelliteProcessRunResponse(body: unknown): Response {
  const payload = isRecord(body) ? body : {};
  const args = Array.isArray(payload.args)
    ? payload.args.map((item) => String(item)).join(" ")
    : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  return jsonResponse(200, {
    output: `ran ${String(payload.command ?? "")} ${args} cwd=${cwd}\n`,
    exitCode: 0,
    timedOut: false,
  });
}

function methodMayHaveBody(method?: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

function parseRequestBody(request: Request, bodyText: string): unknown {
  if (!bodyText) return null;
  if (request.headers.get("content-type")?.includes("application/json")) {
    return JSON.parse(bodyText) as unknown;
  }
  return bodyText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(statusCode: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}

function makeConfig(
  overrides: Partial<E2BSatelliteRunnerConfig> = {},
): E2BSatelliteRunnerConfig {
  return {
    enabled: true,
    provider: "e2b",
    apiKey: "test-key",
    agentRunners: [],
    workdir: "/workspace",
    hostWorkspaceRoot: "/repo",
    timeoutMs: 60_000,
    requestTimeoutMs: 10_000,
    keepAlive: false,
    allowInternetAccess: true,
    envs: {},
    metadata: {},
    ...overrides,
  };
}

const FILE_ENTRY = "file" as SandboxEntryInfo["type"];
const DIR_ENTRY = "dir" as SandboxEntryInfo["type"];

function entry(
  path: string,
  name: string,
  type: SandboxEntryInfo["type"],
): SandboxEntryInfo {
  return {
    path,
    name,
    type,
    size: 12,
    mode: 0o644,
    permissions: "rw-r--r--",
    owner: "user",
    group: "user",
    modifiedTime: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("E2BSatelliteCapabilityRouterService", () => {
  it("resolves explicit E2B Satellite runner settings", () => {
    const config = resolveE2BSatelliteRunnerConfig(
      makeRuntime({
        ELIZA_CODING_SATELLITE_RUNNER: "e2b",
        E2B_API_KEY: "key",
        ELIZA_E2B_WORKDIR: "/work",
        ELIZA_E2B_HOST_WORKSPACE_ROOT: "/repo",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("e2b");
    expect(config.apiKey).toBe("key");
    expect(config.workdir).toBe("/work");
    expect(config.hostWorkspaceRoot).toBe("/repo");
  });

  it("resolves Eliza Cloud runner settings", () => {
    const config = resolveE2BSatelliteRunnerConfig(
      makeRuntime({
        ELIZA_CODING_SATELLITE_RUNNER: "eliza-cloud",
        ELIZA_CLOUD_SANDBOX_BASE_URL: "https://cloud.example/satellite",
        ELIZA_CLOUD_SANDBOX_TOKEN: "token",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("eliza-cloud");
    expect(config.satelliteHttpBaseUrl).toBe("https://cloud.example/satellite");
    expect(config.satelliteHttpToken).toBe("token");
    expect(config.agentRunners).toEqual(["codex", "claude-code", "opencode"]);
  });

  it("resolves Eliza Cloud API-backed provisioning settings", () => {
    const config = resolveE2BSatelliteRunnerConfig(
      makeRuntime({
        ELIZA_CODING_SATELLITE_RUNNER: "eliza-cloud",
        ELIZACLOUD_API_KEY: "cloud-key",
        ELIZA_CLOUD_CODING_SATELLITE_IMAGE:
          "ghcr.io/elizaos/coding-satellite:test",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("eliza-cloud");
    expect(config.satelliteHttpBaseUrl).toBeUndefined();
    expect(config.cloudApiBaseUrl).toBe("https://api.elizacloud.ai/api/v1");
    expect(config.cloudApiToken).toBe("cloud-key");
    expect(config.cloudContainerImage).toBe(
      "ghcr.io/elizaos/coding-satellite:test",
    );
  });

  it("uses provider-specific default workspaces", () => {
    expect(
      resolveE2BSatelliteRunnerConfig(
        makeRuntime({
          ELIZA_CODING_SATELLITE_RUNNER: "e2b",
          E2B_API_KEY: "key",
        }),
      ).workdir,
    ).toBe("/home/user");
    expect(
      resolveE2BSatelliteRunnerConfig(
        makeRuntime({
          ELIZA_CODING_SATELLITE_RUNNER: "eliza-cloud",
          ELIZACLOUD_API_KEY: "cloud-key",
        }),
      ).workdir,
    ).toBe("/workspace");
    expect(
      resolveE2BSatelliteRunnerConfig(
        makeRuntime({
          ELIZA_CODING_SATELLITE_RUNNER: "home",
          ELIZA_HOME_SATELLITE_URL: "http://home.local:2468",
        }),
      ).workdir,
    ).toBe("/workspace");
  });

  it("resolves home runner settings", () => {
    const config = resolveE2BSatelliteRunnerConfig(
      makeRuntime({
        ELIZA_CODING_SATELLITE_RUNNER: "home",
        ELIZA_HOME_SATELLITE_URL: "http://home.local:2468",
        ELIZA_HOME_SATELLITE_ACCESS_URL:
          "https://www.elizacloud.ai/dashboard/app?homeSatelliteSession=session-123",
        ELIZA_HOME_SATELLITE_TOKEN: "token",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("home");
    expect(config.satelliteHttpBaseUrl).toBe("http://home.local:2468");
    expect(config.satelliteAccessUrl).toBe(
      "https://www.elizacloud.ai/dashboard/app?homeSatelliteSession=session-123",
    );
    expect(config.satelliteHttpToken).toBe("token");
    expect(config.agentRunners).toEqual(["codex", "claude-code", "opencode"]);
  });

  it("keeps Vercel, Cloudflare, and Rivet as disabled direct providers", () => {
    for (const provider of ["vercel", "cloudflare", "rivet"]) {
      expect(() =>
        resolveE2BSatelliteRunnerConfig(
          makeRuntime({ ELIZA_CODING_SATELLITE_RUNNER: provider }),
        ),
      ).toThrow(`${provider} runner is disabled`);
    }
  });

  it("accepts an explicit cloud runner list", () => {
    const config = resolveE2BSatelliteRunnerConfig(
      makeRuntime({
        ELIZA_CLOUD_SANDBOX_BASE_URL: "https://cloud.example/satellite",
        ELIZA_SANDBOX_AGENT_RUNNERS: "claude,codex",
      }),
    );

    expect(config.agentRunners).toEqual(["claude-code", "codex"]);
  });

  it("reports structured unavailable when credentials are missing", async () => {
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig({ apiKey: undefined, accessToken: undefined }),
      new FakeFactory(),
    );

    await expect(
      service.pty.runCommand({ command: "echo nope" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "pty",
    });
  });

  it("runs commands in the E2B Satellite runner and maps host workspace paths", async () => {
    const sandbox = new FakeSandbox();
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(sandbox),
    );

    const result = await service.pty.runCommand({
      command: "npm",
      args: ["test"],
      cwd: "/repo/src",
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(result.output).toContain("ran npm 'test'");
    expect(sandbox.commands.runCalls[1]).toMatchObject({
      cmd: "npm 'test'",
      cwd: "/workspace/src",
    });
  });

  it("lists E2B Satellite runner files with hidden and ignore filtering", async () => {
    const sandbox = new FakeSandbox([
      entry("/workspace/src", "src", DIR_ENTRY),
      entry("/workspace/.env", ".env", FILE_ENTRY),
      entry("/workspace/build.log", "build.log", FILE_ENTRY),
    ]);
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(sandbox),
    );

    const result = await service.fs.list({
      path: "/repo",
      ignore: ["*.log"],
      includeHidden: false,
    });

    expect(result.path).toBe("/workspace");
    expect(result.entries.map((item) => item.name)).toEqual(["src"]);
    expect(sandbox.files.listCalls).toContain("/workspace");
  });

  it("routes git helpers through sandbox command execution", async () => {
    const sandbox = new FakeSandbox();
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(sandbox),
    );

    const result = await service.git.commandRun({
      root: "/repo",
      args: ["status", "--short"],
    });

    expect(result.operation.status).toBe("completed");
    expect(sandbox.commands.runCalls.at(-1)).toMatchObject({
      cmd: "git 'status' '--short'",
      cwd: "/workspace",
    });
  });

  it("advertises cloud runner provider and agent runner metadata", async () => {
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig({
        provider: "home",
        apiKey: undefined,
        satelliteHttpBaseUrl: "http://home.local:2468",
        satelliteAccessUrl:
          "https://www.elizacloud.ai/dashboard/app?homeSatelliteSession=session-123",
        agentRunners: ["codex", "opencode"],
      }),
      new FakeFactory(),
    );

    await expect(service.availability()).resolves.toMatchObject({
      available: true,
      capabilities: { fs: true, pty: true, git: true, model: false },
    });
  });

  it.each([
    "eliza-cloud",
    "home",
  ] as const)("routes %s through the Satellite HTTP sandbox contract", async (provider) => {
    const server = await startSatelliteHttpServer();
    try {
      const service = new E2BSatelliteCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider,
          apiKey: undefined,
          satelliteHttpBaseUrl: server.baseUrl,
          satelliteHttpToken: "token",
          agentRunners: ["codex", "claude-code", "opencode"],
        }),
      );

      const list = await service.fs.list({
        path: "/repo",
        includeHidden: true,
      });
      const read = await service.fs.readText({ path: "/repo/README.md" });
      const write = await service.fs.writeText({
        path: "/repo/out.txt",
        text: "ok",
      });
      const command = await service.pty.runCommand({
        command: "echo",
        args: ["hello"],
        cwd: "/repo",
      });
      const git = await service.git.commandRun({
        root: "/repo",
        args: ["status", "--short"],
      });

      expect(list.entries.map((item) => item.kind)).toEqual([
        "directory",
        "file",
      ]);
      expect(read.text).toBe("text:/workspace/README.md");
      expect(write).toEqual({ path: "/workspace/out.txt", bytesWritten: 2 });
      expect(command).toMatchObject({ exitCode: 0, timedOut: false });
      expect(command.output).toContain("echo");
      expect(git.operation.status).toBe("completed");
      expect(git.operation.stdout).toContain("git");
      expect(server.calls.map((call) => call.pathname)).toEqual([
        "/v1/health",
        "/v1/fs/entries",
        "/v1/fs/file",
        "/v1/fs/file",
        "/v1/processes/run",
        "/v1/processes/run",
      ]);
      expect(
        server.calls.every((call) => call.authorization === "Bearer token"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("provisions an Eliza Cloud coding container before using the Satellite HTTP contract", async () => {
    const server = startElizaCloudProvisioningServer();
    try {
      const service = new E2BSatelliteCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "eliza-cloud",
          apiKey: undefined,
          cloudApiBaseUrl: server.baseUrl,
          cloudApiToken: "cloud-key",
          agentRunners: ["codex", "claude-code", "opencode"],
        }),
      );

      const list = await service.fs.list({
        path: "/repo",
        includeHidden: true,
      });

      expect(list.entries.map((item) => item.name)).toEqual([
        "src",
        "README.md",
      ]);
      expect(server.calls.map((call) => call.pathname)).toEqual([
        "/api/v1/coding-containers",
        "/v1/health",
        "/v1/fs/entries",
      ]);
      expect(server.calls[0]).toMatchObject({
        authorization: "Bearer cloud-key",
        body: {
          agent: "codex",
          workspacePath: "/workspace",
        },
      });
      const provisionBody = server.calls[0]?.body;
      expect(provisionBody).toMatchObject({
        container: {
          environmentVars: {
            ELIZA_CODING_WORKSPACE: "/workspace",
            ELIZA_SANDBOX_AGENT_RUNNERS: "codex,claude-code,opencode",
          },
        },
      });
      const satelliteToken = (
        provisionBody as {
          container?: { environmentVars?: Record<string, string> };
        }
      ).container?.environmentVars?.ELIZA_SATELLITE_HTTP_TOKEN;
      expect(satelliteToken).toEqual(expect.any(String));
      expect(
        server.calls
          .slice(1)
          .every((call) => call.authorization === `Bearer ${satelliteToken}`),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects host paths outside the mapped workspace", async () => {
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(),
    );

    await expect(
      service.fs.readText({ path: "/outside/file.ts" }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});
