/**
 * Unit tests for RemoteCodingCapabilityRouterService: runner-config resolution from
 * runtime settings across the eliza-cloud / home providers (and the
 * disabled vercel / cloudflare / rivet ones), plus fs/pty/git routing,
 * host↔sandbox path mapping, and cloud coding-container provisioning. Uses fake
 * sandbox factories and fetch-mocked remote-runner / cloud HTTP servers.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  AgentRuntime,
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type IAgentRuntime,
  type JsonValue,
  type Memory,
  RuntimeBrokerCapabilityRouter,
  type UUID,
  type WorkspaceDeltaReceipt,
} from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codingToolsPlugin, {
  SANDBOX_SERVICE,
  SandboxService,
  SESSION_CWD_SERVICE,
  SessionCwdService,
} from "../../../../plugins/plugin-coding-tools/src/index.ts";
import { __codingMutationRequiresVerificationForTests } from "../../../core/src/runtime/planner-loop.ts";
import {
  DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  RemoteCodingCapabilityRouterService,
  type RemoteCodingRunnerConfig,
  type RemoteRunnerClient,
  type RemoteRunnerFactory,
  resolveRemoteCodingRunnerConfig,
  type SandboxCommandResult,
  type SandboxEntryInfo,
} from "./remote-coding-runner.ts";

const execFileAsync = promisify(execFile);

class FakeFiles {
  readonly listCalls: string[] = [];
  readonly readCalls: string[] = [];
  readonly writeCalls: Array<{ path: string; text: string }> = [];

  constructor(
    private readonly entries: SandboxEntryInfo[] = [],
    private readonly readText = "file text",
  ) {}

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
    return this.readText;
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

class FakeSandbox implements RemoteRunnerClient {
  readonly sandboxId = "sbx_test";
  readonly files: FakeFiles;
  readonly commands = new FakeCommands();
  readonly kill = vi.fn(async () => {});

  constructor(entries: SandboxEntryInfo[] = [], readText?: string) {
    this.files = new FakeFiles(entries, readText);
  }
}

class LocalProcessSandbox implements RemoteRunnerClient {
  readonly sandboxId: string;
  readonly workspacePrepared = true;

  constructor(
    readonly root: string,
    sandboxId = `local-${path.basename(root)}`,
  ) {
    this.sandboxId = sandboxId;
  }

  readonly commands = {
    run: async (
      cmd: string,
      opts: {
        cwd?: string;
        timeoutMs?: number;
        envs?: Record<string, string>;
      } = {},
    ): Promise<SandboxCommandResult> => {
      try {
        const result = await execFileAsync(
          "/bin/bash",
          ["--noprofile", "--norc", "-o", "pipefail", "-c", cmd],
          {
            cwd: opts.cwd ?? this.root,
            env: { ...process.env, ...opts.envs },
            encoding: "utf8",
            timeout: opts.timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        return {
          exitCode:
            typeof failure.code === "number"
              ? failure.code
              : failure.killed
                ? 137
                : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message,
          timedOut: failure.killed === true,
        };
      }
    },
  };

  readonly files = {
    list: async (target: string): Promise<SandboxEntryInfo[]> => {
      const directory = await fs.opendir(target);
      const entries: SandboxEntryInfo[] = [];
      for await (const item of directory) {
        const absolute = path.join(target, item.name);
        const stat = await fs.lstat(absolute);
        entries.push({
          path: absolute,
          name: item.name,
          type: item.isFile()
            ? "file"
            : item.isDirectory()
              ? "dir"
              : item.isSymbolicLink()
                ? "symlink"
                : "other",
          size: stat.size,
          mode: stat.mode,
          modifiedTime: stat.mtime,
          ...(item.isSymbolicLink()
            ? { symlinkTarget: await fs.readlink(absolute) }
            : {}),
        });
      }
      return entries;
    },
    read: async (
      target: string,
      opts?: { format?: "text" | "bytes" },
    ): Promise<string | Uint8Array> =>
      opts?.format === "bytes"
        ? new Uint8Array(await fs.readFile(target))
        : await fs.readFile(target, "utf8"),
    write: async (target: string, data: string) => {
      await fs.writeFile(target, data);
      return { path: target, name: path.basename(target) };
    },
  };

  readonly kill = vi.fn(async () => {});
}

class FakeFactory implements RemoteRunnerFactory {
  readonly configs: RemoteCodingRunnerConfig[] = [];

  constructor(readonly sandbox: RemoteRunnerClient = new FakeSandbox()) {}

  async create(config: RemoteCodingRunnerConfig): Promise<RemoteRunnerClient> {
    this.configs.push(config);
    return this.sandbox;
  }
}

type RemoteRunnerHttpCall = {
  method: string;
  pathname: string;
  authorization: string | null;
  redirect: RequestRedirect;
  body: unknown;
};

type RemoteRunnerHttpServer = {
  baseUrl: string;
  calls: RemoteRunnerHttpCall[];
  close: () => Promise<void>;
};

type RemoteRunnerRouteContext = {
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

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs = 250,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Operation did not settle after teardown.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function makeRuntime(
  settings: Record<string, string> = {},
  services: Record<string, unknown> = {},
): IAgentRuntime {
  const runtime: Partial<IAgentRuntime> = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Remote Runner Test" },
    getSetting: (key: string) => settings[key],
    getService: ((type: string) => services[type] ?? null) as never,
  };
  return runtime as IAgentRuntime;
}

function bunAbortError(): DOMException {
  // Bun 1.3.14 fetch rejects this way even when abort(reason) was used.
  return new DOMException("The operation was aborted.", "AbortError");
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
}

function hungFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const abort = () => {
      reject(bunAbortError());
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function partialBodyFetch(
  bodyPrefix: string,
  status = 200,
): (_input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bodyPrefix));
        const abort = () => {
          controller.error(bunAbortError());
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      },
    });
    return new Response(body, { status });
  };
}

function healthThenProcessFetch(
  processImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  const originalFetch = globalThis.fetch;
  return Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/v1/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname.endsWith("/v1/processes/run")) {
        return processImpl(input, init);
      }
      return jsonResponse(404, { error: "not found" });
    },
    { preconnect: originalFetch.preconnect },
  );
}

function remoteCommandTimeoutConfig(): RemoteCodingRunnerConfig {
  return makeConfig({
    provider: "home",
    remoteHttpBaseUrl: "https://remote-runner.test",
    remoteHttpToken: "token",
    timeoutMs: 50,
    requestTimeoutMs: 50,
  });
}

function startRemoteRunnerHttpServer(): RemoteRunnerHttpServer {
  const calls: RemoteRunnerHttpCall[] = [];
  const originalFetch = globalThis.fetch;
  const fetchMock: typeof fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const request = new Request(input, init);
      return handleRemoteRunnerHttpRequest(request, calls);
    },
    { preconnect: originalFetch.preconnect },
  );
  replaceGlobalFetch(fetchMock);
  return {
    baseUrl: "https://remote-runner.test",
    calls,
    close: async () => {
      replaceGlobalFetch(originalFetch);
    },
  };
}

function startElizaCloudProvisioningServer(): RemoteRunnerHttpServer {
  const calls: RemoteRunnerHttpCall[] = [];
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
          redirect: request.redirect,
          body: parseRequestBody(request, bodyText),
        });
        return jsonResponse(201, {
          success: true,
          data: {
            containerId: "cloud-container-1",
            status: "running",
            agent: "codex",
            workspacePath: "/workspace",
            url: "https://remote-runner.test",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });
      }
      return handleRemoteRunnerHttpRequest(request, calls);
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

async function handleRemoteRunnerHttpRequest(
  request: Request,
  calls: RemoteRunnerHttpCall[],
): Promise<Response> {
  const context = await readRemoteRunnerRouteContext(request);
  recordRemoteRunnerHttpCall(context, calls);
  if (!isAuthorizedRemoteRunnerRequest(request)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  return remoteRouteResponse(context);
}

async function readRemoteRunnerRouteContext(
  request: Request,
): Promise<RemoteRunnerRouteContext> {
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

function recordRemoteRunnerHttpCall(
  context: RemoteRunnerRouteContext,
  calls: RemoteRunnerHttpCall[],
): void {
  calls.push({
    method: context.request.method,
    pathname: context.url.pathname,
    authorization: context.request.headers.get("authorization"),
    redirect: context.request.redirect,
    body: context.body,
  });
}

function remoteRouteResponse(context: RemoteRunnerRouteContext): Response {
  const route = `${context.request.method} ${context.url.pathname}`;
  if (route === "GET /v1/health") {
    return jsonResponse(200, { ok: true });
  }
  if (route === "GET /v1/fs/entries") {
    return remoteEntriesResponse(context.url);
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
    return remoteProcessRunResponse(context.body);
  }
  return jsonResponse(404, { error: "not found" });
}

function isAuthorizedRemoteRunnerRequest(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  return (
    authorization === "Bearer token" ||
    authorization === "Bearer cloud-key" ||
    Boolean(authorization?.startsWith("Bearer "))
  );
}

function remoteEntriesResponse(url: URL): Response {
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

function remoteProcessRunResponse(body: unknown): Response {
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
  overrides: Partial<RemoteCodingRunnerConfig> = {},
): RemoteCodingRunnerConfig {
  return {
    enabled: true,
    provider: "home",
    remoteHttpBaseUrl: "http://home.local:2468",
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

describe("RemoteCodingCapabilityRouterService", () => {
  it("resolves Eliza Cloud runner settings", () => {
    const config = resolveRemoteCodingRunnerConfig(
      makeRuntime({
        ELIZA_CODING_REMOTE_RUNNER: "eliza-cloud",
        ELIZA_CLOUD_SANDBOX_BASE_URL: "https://cloud.example/remote-runner",
        ELIZA_CLOUD_SANDBOX_TOKEN: "token",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("eliza-cloud");
    expect(config.remoteHttpBaseUrl).toBe(
      "https://cloud.example/remote-runner",
    );
    expect(config.remoteHttpToken).toBe("token");
    expect(config.agentRunners).toEqual(["codex", "claude-code"]);
  });

  it("resolves Eliza Cloud API-backed provisioning settings", () => {
    const config = resolveRemoteCodingRunnerConfig(
      makeRuntime({
        ELIZA_CODING_REMOTE_RUNNER: "eliza-cloud",
        ELIZACLOUD_API_KEY: "cloud-key",
        ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE:
          "ghcr.io/elizaos/coding-remote-runner:test",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("eliza-cloud");
    expect(config.remoteHttpBaseUrl).toBeUndefined();
    expect(config.cloudApiBaseUrl).toBe(DEFAULT_ELIZA_CLOUD_API_BASE_URL);
    expect(config.cloudApiToken).toBe("cloud-key");
    expect(config.cloudContainerImage).toBe(
      "ghcr.io/elizaos/coding-remote-runner:test",
    );
  });

  it("uses the remote-runner default workspace", () => {
    expect(
      resolveRemoteCodingRunnerConfig(
        makeRuntime({
          ELIZA_CODING_REMOTE_RUNNER: "eliza-cloud",
          ELIZACLOUD_API_KEY: "cloud-key",
        }),
      ).workdir,
    ).toBe("/workspace");
    expect(
      resolveRemoteCodingRunnerConfig(
        makeRuntime({
          ELIZA_CODING_REMOTE_RUNNER: "home",
          ELIZA_HOME_REMOTE_RUNNER_URL: "http://home.local:2468",
        }),
      ).workdir,
    ).toBe("/workspace");
  });

  it("resolves home runner settings", () => {
    const config = resolveRemoteCodingRunnerConfig(
      makeRuntime({
        ELIZA_CODING_REMOTE_RUNNER: "home",
        ELIZA_HOME_REMOTE_RUNNER_URL: "http://home.local:2468",
        ELIZA_HOME_REMOTE_RUNNER_ACCESS_URL:
          "https://www.elizacloud.ai/dashboard/app?homeRemoteRunnerSession=session-123",
        ELIZA_HOME_REMOTE_RUNNER_TOKEN: "token",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("home");
    expect(config.remoteHttpBaseUrl).toBe("http://home.local:2468");
    expect(config.remoteAccessUrl).toBe(
      "https://www.elizacloud.ai/dashboard/app?homeRemoteRunnerSession=session-123",
    );
    expect(config.remoteHttpToken).toBe("token");
    expect(config.agentRunners).toEqual(["codex", "claude-code"]);
  });

  describe("launcher-owned dev Cloud authority", () => {
    const authorityEnvKeys = [
      "ELIZA_DEV_SOURCE",
      "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
      "ELIZA_DEV_CLOUD_TARGET",
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_BASE_URL",
      "ELIZA_CLOUD_REMOTE_RUNNER_URL",
      "ELIZA_CLOUD_SANDBOX_TOKEN",
    ] as const;
    const originalAuthorityEnv = Object.fromEntries(
      authorityEnvKeys.map((key) => [key, process.env[key]]),
    ) as Record<(typeof authorityEnvKeys)[number], string | undefined>;

    beforeEach(() => {
      resetDevCloudEnvAuthorityForTests();
      for (const key of authorityEnvKeys) delete process.env[key];
    });

    afterEach(() => {
      for (const key of authorityEnvKeys) {
        const value = originalAuthorityEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetDevCloudEnvAuthorityForTests();
    });

    it.each(["staging-default", "offline"] as const)(
      "does not revive the Cloud runner from late production env in %s mode",
      (authority) => {
        process.env.ELIZA_DEV_SOURCE = "1";
        process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
        process.env.ELIZA_DEV_CLOUD_TARGET =
          authority === "offline" ? "offline" : "staging";
        process.env.ELIZAOS_CLOUD_BASE_URL =
          "https://api-staging.eliza.app/api/v1";
        captureDevCloudEnvAuthoritySnapshot();

        process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
        process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
        process.env.ELIZA_CLOUD_REMOTE_RUNNER_URL =
          "https://production-runner.example";
        process.env.ELIZA_CLOUD_SANDBOX_TOKEN = "late-production-token";

        const config = resolveRemoteCodingRunnerConfig(
          makeRuntime({
            ELIZA_CODING_REMOTE_RUNNER: "eliza-cloud",
            ELIZAOS_CLOUD_API_KEY: "",
            ELIZAOS_CLOUD_BASE_URL: "",
            ELIZA_CLOUD_REMOTE_RUNNER_URL: "",
            ELIZA_CLOUD_SANDBOX_TOKEN: "",
          }),
        );

        expect(config.cloudApiBaseUrl).toBe(
          "https://api-staging.eliza.app/api/v1",
        );
        expect(config.cloudApiToken).toBeUndefined();
        expect(config.remoteHttpBaseUrl).toBeUndefined();
        expect(config.remoteHttpToken).toBeUndefined();
      },
    );

    it("uses the frozen explicit staging credential after late env pollution", () => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
      process.env.ELIZA_DEV_CLOUD_TARGET = "staging";
      process.env.ELIZAOS_CLOUD_API_KEY = "launcher-staging-key";
      process.env.ELIZAOS_CLOUD_BASE_URL =
        "https://api-staging.eliza.app/api/v1";
      captureDevCloudEnvAuthoritySnapshot();

      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

      const config = resolveRemoteCodingRunnerConfig(
        makeRuntime({
          ELIZA_CODING_REMOTE_RUNNER: "eliza-cloud",
          ELIZAOS_CLOUD_API_KEY: "persisted-production-key",
          ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
        }),
      );

      expect(config.cloudApiBaseUrl).toBe(
        "https://api-staging.eliza.app/api/v1",
      );
      expect(config.cloudApiToken).toBe("launcher-staging-key");
    });

    it("leaves Home runner resolution unchanged under Cloud authority", () => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "offline";
      process.env.ELIZA_DEV_CLOUD_TARGET = "offline";
      captureDevCloudEnvAuthoritySnapshot();

      const config = resolveRemoteCodingRunnerConfig(
        makeRuntime({
          ELIZA_CODING_REMOTE_RUNNER: "home",
          ELIZA_HOME_REMOTE_RUNNER_URL: "http://home.local:2468",
          ELIZA_HOME_REMOTE_RUNNER_TOKEN: "home-token",
        }),
      );

      expect(config.provider).toBe("home");
      expect(config.remoteHttpBaseUrl).toBe("http://home.local:2468");
      expect(config.remoteHttpToken).toBe("home-token");
    });
  });

  it("rejects runner timeout settings that overflow the JavaScript timer range", () => {
    expect(() =>
      resolveRemoteCodingRunnerConfig(
        makeRuntime({
          ELIZA_CODING_REMOTE_RUNNER: "home",
          ELIZA_HOME_REMOTE_RUNNER_URL: "http://home.local:2468",
          ELIZA_HOME_REMOTE_RUNNER_REQUEST_TIMEOUT_MS: "2147483648",
        }),
      ),
    ).toThrow(/must be an integer between 1 and 2147483647/i);
  });

  it("keeps Vercel, Cloudflare, and Rivet as disabled direct providers", () => {
    for (const provider of ["vercel", "cloudflare", "rivet"]) {
      expect(() =>
        resolveRemoteCodingRunnerConfig(
          makeRuntime({ ELIZA_CODING_REMOTE_RUNNER: provider }),
        ),
      ).toThrow(`${provider} runner is disabled`);
    }
  });

  it("accepts an explicit cloud runner list", () => {
    const config = resolveRemoteCodingRunnerConfig(
      makeRuntime({
        ELIZA_CLOUD_SANDBOX_BASE_URL: "https://cloud.example/remote-runner",
        ELIZA_SANDBOX_AGENT_RUNNERS: "claude,codex",
      }),
    );

    expect(config.agentRunners).toEqual(["claude-code", "codex"]);
  });

  it("rejects non-canonical request timeouts and values outside the platform timer range", () => {
    // Two distinct rejections: a value that is not a canonical decimal integer
    // never reaches the range check, while a canonical value above the timer
    // ceiling passes the shape check and is rejected on range.
    for (const value of ["0", "01", "+1", "1.0", "1e3"]) {
      expect(() =>
        resolveRemoteCodingRunnerConfig(
          makeRuntime({
            ELIZA_CODING_REMOTE_RUNNER: "home",
            ELIZA_HOME_REMOTE_RUNNER_URL: "http://home.local:2468",
            ELIZA_HOME_REMOTE_RUNNER_REQUEST_TIMEOUT_MS: value,
          }),
        ),
      ).toThrow(
        "ELIZA_HOME_REMOTE_RUNNER_REQUEST_TIMEOUT_MS must be a canonical integer from 1 to 2147483647.",
      );
    }

    expect(() =>
      resolveRemoteCodingRunnerConfig(
        makeRuntime({
          ELIZA_CODING_REMOTE_RUNNER: "home",
          ELIZA_HOME_REMOTE_RUNNER_URL: "http://home.local:2468",
          ELIZA_HOME_REMOTE_RUNNER_REQUEST_TIMEOUT_MS: "2147483648",
        }),
      ),
    ).toThrow(
      "ELIZA_HOME_REMOTE_RUNNER_REQUEST_TIMEOUT_MS must be an integer between 1 and 2147483647.",
    );
  });

  it("reports structured unavailable when credentials are missing", async () => {
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig({ remoteHttpBaseUrl: undefined }),
      new FakeFactory(),
    );

    await expect(
      service.pty.runCommand({ command: "echo nope" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "pty",
    });
  });

  it("runs commands in the remote runner and maps host workspace paths", async () => {
    const sandbox = new FakeSandbox();
    const service = new RemoteCodingCapabilityRouterService(
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
    expect(
      sandbox.commands.runCalls.find((call) => call.cmd === "npm 'test'"),
    ).toMatchObject({
      cmd: "npm 'test'",
      cwd: "/workspace/src",
    });
  });

  it("observes the canonical remote Git root through the production PTY endpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-observer-"));
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, "tracked.txt"), "before\n");
      await fs.mkdir(path.join(root, "nested"));
      await execFileAsync("git", ["add", "."], { cwd: root });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "initial",
        ],
        { cwd: root },
      );
      const sandbox = new LocalProcessSandbox(root);
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({ workdir: root, hostWorkspaceRoot: root }),
        new FakeFactory(sandbox),
      );

      const changed = await service.pty.runCommand({
        command: "printf 'after\\n' > ../tracked.txt",
        cwd: path.join(root, "nested"),
      });
      const unchanged = await service.pty.runCommand({
        command: "true",
        cwd: path.join(root, "nested"),
      });

      expect(changed.workspaceDeltaReceipt).toMatchObject({
        outcome: "changed",
        scope: changed.workspaceExecution,
      });
      expect(unchanged.workspaceDeltaReceipt).toMatchObject({
        outcome: "unchanged",
        scope: changed.workspaceExecution,
      });
      expect(changed.workspaceExecution).toMatchObject({
        root: await fs.realpath(root),
        rootId: expect.stringMatching(/^[a-f0-9]{64}$/),
        executionDomainId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("detects remote index exceptions, nested symlinks, modes, and dirty submodules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-special-"));
    const child = await fs.mkdtemp(path.join(os.tmpdir(), "remote-submodule-"));
    const commit = async (cwd: string, message: string) => {
      await execFileAsync("git", ["add", "."], { cwd });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          message,
        ],
        { cwd },
      );
    };
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, "tracked.txt"), "initial\n");
      await fs.writeFile(path.join(root, "verify.js"), "export {};\n");
      await commit(root, "initial");
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({ workdir: root, hostWorkspaceRoot: root }),
        new FakeFactory(new LocalProcessSandbox(root)),
      );

      await execFileAsync(
        "git",
        ["update-index", "--assume-unchanged", "tracked.txt"],
        { cwd: root },
      );
      expect(
        (
          await service.pty.runCommand({
            command: "printf assume > tracked.txt",
            cwd: root,
          })
        ).workspaceDeltaReceipt,
      ).toMatchObject({ outcome: "changed" });
      await execFileAsync(
        "git",
        ["update-index", "--no-assume-unchanged", "tracked.txt"],
        { cwd: root },
      );
      await execFileAsync("git", ["checkout", "--", "tracked.txt"], {
        cwd: root,
      });

      await execFileAsync(
        "git",
        ["update-index", "--skip-worktree", "tracked.txt"],
        { cwd: root },
      );
      expect(
        (
          await service.pty.runCommand({
            command: "printf skip > tracked.txt",
            cwd: root,
          })
        ).workspaceDeltaReceipt,
      ).toMatchObject({ outcome: "changed" });
      await execFileAsync(
        "git",
        ["update-index", "--no-skip-worktree", "tracked.txt"],
        { cwd: root },
      );
      await execFileAsync("git", ["checkout", "--", "tracked.txt"], {
        cwd: root,
      });

      await fs.mkdir(path.join(root, "untracked", "nested"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(root, "untracked", "nested", "mode.txt"),
        "mode\n",
      );
      await fs.symlink(
        "mode.txt",
        path.join(root, "untracked", "nested", "link"),
      );
      expect(
        (
          await service.pty.runCommand({
            command:
              "chmod 700 untracked/nested/mode.txt && ln -snf ../mode.txt untracked/nested/link",
            cwd: root,
          })
        ).workspaceDeltaReceipt,
      ).toMatchObject({ outcome: "changed" });

      await execFileAsync("git", ["init", "-q"], { cwd: child });
      await fs.writeFile(path.join(child, "child.txt"), "initial\n");
      await commit(child, "child");
      await execFileAsync(
        "git",
        [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "-q",
          child,
          "submodule",
        ],
        { cwd: root },
      );
      await commit(root, "submodule");
      await fs.writeFile(
        path.join(root, "submodule", "child.txt"),
        "dirty-before\n",
      );
      expect(
        (
          await service.pty.runCommand({
            command: "printf dirty-after > submodule/child.txt",
            cwd: root,
          })
        ).workspaceDeltaReceipt,
      ).toMatchObject({ outcome: "changed" });
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(child, { recursive: true, force: true }),
      ]);
    }
  });

  it.each([
    ["file bytes", { maxFileBytes: 1 }, "OBSERVATION_BYTE_BUDGET_EXCEEDED"],
    [
      "Git output",
      { maxGitOutputBytes: 1 },
      "OBSERVATION_OUTPUT_BUDGET_EXCEEDED",
    ],
    [
      "directory entries",
      { maxDirectoryEntries: 1 },
      "OBSERVATION_BYTE_BUDGET_EXCEEDED",
    ],
    [
      "directory names",
      { maxDirectoryNameBytes: 1 },
      "OBSERVATION_BYTE_BUDGET_EXCEEDED",
    ],
    ["wall clock", { maxObservationMs: 1 }, "OBSERVATION_TIME_BUDGET_EXCEEDED"],
  ] as const)(
    "fails closed at the remote %s observation budget",
    async (_name, limits, reasonCode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-budget-"));
      try {
        await execFileAsync("git", ["init", "-q"], { cwd: root });
        const embedded = path.join(root, "embedded");
        await fs.mkdir(embedded);
        await execFileAsync("git", ["init", "-q"], { cwd: embedded });
        await fs.writeFile(
          path.join(embedded, "long-entry-one.txt"),
          "payload\n",
        );
        await fs.writeFile(
          path.join(embedded, "long-entry-two.txt"),
          "payload\n",
        );
        const service = new RemoteCodingCapabilityRouterService(
          makeRuntime(),
          makeConfig({ workdir: root, hostWorkspaceRoot: root }),
          new FakeFactory(new LocalProcessSandbox(root)),
          limits,
        );
        const result = await service.pty.runCommand({
          command: "true",
          cwd: root,
        });
        expect(result.workspaceDeltaReceipt).toMatchObject({
          outcome: "indeterminate",
          reasonCode,
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("carries production endpoint receipts through RuntimeBroker, SHELL, and planner scope matching", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "remote-receipt-e2e-"),
    );
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, "tracked.txt"), "initial\n");
      await fs.writeFile(path.join(root, "verify.js"), "export {};\n");
      await execFileAsync("git", ["add", "."], { cwd: root });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "initial",
        ],
        { cwd: root },
      );
      const sandbox = new LocalProcessSandbox(root, "conformance-sandbox");
      const endpoint = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({ hostWorkspaceRoot: root, workdir: root }),
        new FakeFactory(sandbox),
      );
      let brokerMode: "normal" | "unavailable" | "malformed" | "mismatch" =
        "normal";
      const router = new RuntimeBrokerCapabilityRouter({
        environment: endpoint.environment,
        invokeRuntime: async (method, params) => {
          if (method !== "pty.command.run") {
            throw new Error(`Unexpected broker method: ${method}`);
          }
          if (brokerMode === "unavailable") {
            throw new CapabilityError({
              code: "CAPABILITY_UNAVAILABLE",
              capability: "pty",
              method: "pty.command.run",
              message: "exercise local fallback",
            });
          }
          const produced = await endpoint.pty.runCommand(params as never);
          if (brokerMode === "malformed") {
            return {
              ...produced,
              workspaceDeltaReceipt: {
                ...produced.workspaceDeltaReceipt,
                unexpected: true,
              },
            } as unknown as JsonValue;
          }
          if (brokerMode === "mismatch") {
            return {
              ...produced,
              workspaceExecution: produced.workspaceExecution
                ? {
                    ...produced.workspaceExecution,
                    rootId: "f".repeat(64),
                  }
                : undefined,
            } as unknown as JsonValue;
          }
          return produced as unknown as JsonValue;
        },
      });
      const action = codingToolsPlugin.actions?.find(
        (candidate) => candidate.name === "SHELL",
      );
      if (!action?.handler) throw new Error("SHELL action unavailable");
      const owner = new AgentRuntime({
        character: { name: "remote-receipt-conformance" } as never,
      });
      const services = new Map<string, unknown>();
      const runtime = {
        agentId: owner.agentId,
        runtimeInstanceId: "55555555-5555-4555-8555-555555555555" as UUID,
        actions: [action],
        character: owner.character,
        getSetting: (key: string) =>
          key === "CODING_TOOLS_WORKSPACE_ROOTS" ? root : undefined,
        getService: <T>(type: string) => (services.get(type) as T) ?? null,
        redactSecrets: (text: string) => text,
        locateConfiguredSecretFragmentTaint:
          owner.locateConfiguredSecretFragmentTaint.bind(owner),
        logger: owner.logger,
      } as IAgentRuntime;
      const sandboxService = await SandboxService.start(runtime);
      const sessionService = await SessionCwdService.start(runtime);
      services.set(SANDBOX_SERVICE, sandboxService);
      services.set(SESSION_CWD_SERVICE, sessionService);
      services.set(CAPABILITY_ROUTER_SERVICE_TYPE, router);
      const roomId = "22222222-2222-2222-2222-222222222222" as UUID;
      sessionService.setCwd(String(roomId), root);
      const message = {
        id: "33333333-3333-3333-3333-333333333333" as UUID,
        roomId,
        entityId: "44444444-4444-4444-4444-444444444444" as UUID,
        content: { text: "mutate and verify" },
      } as Memory;
      const run = async (command: string) =>
        await action.handler?.(runtime, message, undefined, { command });
      const changed = await run("printf mutate > remote.txt");
      brokerMode = "malformed";
      const malformed = await run("node --check verify.js");
      brokerMode = "mismatch";
      const mismatch = await run("node --check verify.js");
      brokerMode = "unavailable";
      const local = await run("true");
      brokerMode = "normal";
      const remoteUnchanged = await run("node --check verify.js");
      const commands = [
        "printf mutate > remote.txt",
        "node --check verify.js",
        "node --check verify.js",
        "true",
        "node --check verify.js",
      ];
      const steps = [changed, malformed, mismatch, local, remoteUnchanged].map(
        (result, index) => ({
          toolCall: {
            name: "SHELL",
            params: { command: commands[index] },
          },
          result,
        }),
      );
      const trajectorySteps = [steps[0]];
      const trajectory = {
        steps: trajectorySteps,
        archivedSteps: [],
      } as unknown as Parameters<
        typeof __codingMutationRequiresVerificationForTests
      >[0];
      const changedReceipt = changed?.data?.workspaceDeltaReceipt as
        | WorkspaceDeltaReceipt
        | undefined;
      expect(changedReceipt).toMatchObject({
        outcome: "changed",
      });
      if (!changedReceipt) throw new Error("changed receipt unavailable");
      expect(malformed?.data?.workspaceDeltaReceipt).toMatchObject({
        outcome: "indeterminate",
        reasonCode: "REMOTE_EXECUTION_UNOBSERVED",
      });
      expect(mismatch?.data?.workspaceDeltaReceipt).toMatchObject({
        outcome: "indeterminate",
        reasonCode: "REMOTE_EXECUTION_UNOBSERVED",
      });
      for (const negative of [steps[1], steps[2]]) {
        const negativeTrajectory = {
          steps: [steps[0], negative, steps[4]],
          archivedSteps: [],
        } as unknown as Parameters<
          typeof __codingMutationRequiresVerificationForTests
        >[0];
        expect(
          __codingMutationRequiresVerificationForTests(negativeTrajectory),
        ).toBe(true);
      }
      expect(__codingMutationRequiresVerificationForTests(trajectory)).toBe(
        true,
      );
      trajectorySteps.push(steps[3]);
      expect(__codingMutationRequiresVerificationForTests(trajectory)).toBe(
        true,
      );
      expect(remoteUnchanged?.data?.workspaceDeltaReceipt).toMatchObject({
        outcome: "unchanged",
        scope: changedReceipt.scope,
      });
      const verifiedRemoteTrajectory = {
        steps: [steps[0], steps[4]],
        archivedSteps: [],
      } as unknown as Parameters<
        typeof __codingMutationRequiresVerificationForTests
      >[0];
      expect(
        __codingMutationRequiresVerificationForTests(verifiedRemoteTrajectory),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retries runner creation after a transient failure instead of caching the rejection", async () => {
    const sandbox = new FakeSandbox([
      entry("/workspace/README.md", "README.md", FILE_ENTRY),
    ]);
    let attempts = 0;
    const transientError = new Error("transient sandbox provisioning failure");
    const factory: RemoteRunnerFactory = {
      create: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw transientError;
        }
        return sandbox;
      },
    };
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      factory,
    );

    await expect(service.fs.list({})).rejects.toBe(transientError);

    const result = await service.fs.list({});
    expect(result.entries.map((item) => item.name)).toEqual(["README.md"]);
    expect(attempts).toBe(2);
  });

  it("retries preparation on the same sandbox after a transient workspace failure", async () => {
    const sandbox = new FakeSandbox([
      entry("/workspace/README.md", "README.md", FILE_ENTRY),
    ]);
    const factory = new FakeFactory(sandbox);
    const runCommand = sandbox.commands.run.bind(sandbox.commands);
    let preparationAttempts = 0;
    const transientError = new Error("transient workspace preparation failure");
    vi.spyOn(sandbox.commands, "run").mockImplementation(async (cmd, opts) => {
      const result = await runCommand(cmd, opts);
      if (cmd.startsWith("mkdir ")) {
        preparationAttempts += 1;
        if (preparationAttempts === 1) {
          // Model a lost response after mkdir has already mutated the workspace.
          throw transientError;
        }
      }
      return result;
    });
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      factory,
    );

    await expect(service.fs.list({})).rejects.toBe(transientError);
    expect(factory.configs).toHaveLength(1);
    expect(preparationAttempts).toBe(1);
    expect(sandbox.files.listCalls).toHaveLength(0);

    const retried = await service.fs.list({});
    expect(retried.entries.map((item) => item.name)).toEqual(["README.md"]);

    await service.fs.list({});
    await Promise.all([service.fs.list({}), service.fs.list({})]);

    expect(factory.configs).toHaveLength(1);
    expect(preparationAttempts).toBe(2);
    expect(sandbox.files.listCalls).toHaveLength(4);
  });

  it("creates the runner once across many successful operations", async () => {
    const sandbox = new FakeSandbox([
      entry("/workspace/README.md", "README.md", FILE_ENTRY),
    ]);
    const factory = new FakeFactory(sandbox);
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      factory,
    );

    await service.fs.list({});
    await service.fs.list({});
    await Promise.all([service.fs.list({}), service.fs.list({})]);

    expect(factory.configs).toHaveLength(1);
  });

  it("lists remote runner files with hidden and ignore filtering", async () => {
    const sandbox = new FakeSandbox([
      entry("/workspace/src", "src", DIR_ENTRY),
      entry("/workspace/.env", ".env", FILE_ENTRY),
      entry("/workspace/build.log", "build.log", FILE_ENTRY),
    ]);
    const service = new RemoteCodingCapabilityRouterService(
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
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(sandbox),
    );

    const result = await service.git.commandRun({
      root: "/repo",
      args: ["status", "--short"],
    });

    expect(result.operation.status).toBe("completed");
    expect(
      sandbox.commands.runCalls.find(
        (call) => call.cmd === "git 'status' '--short'",
      ),
    ).toMatchObject({
      cmd: "git 'status' '--short'",
      cwd: "/workspace",
    });
  });

  it("advertises cloud runner provider and agent runner metadata", async () => {
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig({
        provider: "home",
        remoteHttpBaseUrl: "http://home.local:2468",
        remoteAccessUrl:
          "https://www.elizacloud.ai/dashboard/app?homeRemoteRunnerSession=session-123",
        agentRunners: ["codex"],
      }),
      new FakeFactory(),
    );

    await expect(service.availability()).resolves.toMatchObject({
      available: true,
      capabilities: { fs: true, pty: true, git: true, model: false },
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects an invalid fs.readText maxBytes value: %s", async (maxBytes) => {
    const factory = new FakeFactory();
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      factory,
    );

    await expect(
      service.fs.readText({ path: "/repo/README.md", maxBytes }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_REQUEST_FAILED",
      capability: "fs",
      method: "fs.readText",
      message: "fs.readText maxBytes must be a positive safe integer.",
    });
    expect(factory.configs).toHaveLength(0);
  });

  it("rejects a file above maxBytes without returning partial text", async () => {
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(new FakeSandbox([], "éclair")),
    );

    await expect(
      service.fs.readText({ path: "/repo/README.md", maxBytes: 1 }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_REQUEST_FAILED",
      capability: "fs",
      method: "fs.readText",
      message:
        "fs.readText requires 7 bytes, exceeding the requested 1-byte acceptance ceiling.",
    });
    await expect(
      service.fs.readText({ path: "/repo/README.md", maxBytes: 3 }),
    ).rejects.toMatchObject({
      message:
        "fs.readText requires 7 bytes, exceeding the requested 3-byte acceptance ceiling.",
    });
  });

  it.each(["eliza-cloud", "home"] as const)(
    "routes %s through the remote runner HTTP sandbox contract",
    async (provider) => {
      const server = await startRemoteRunnerHttpServer();
      try {
        const service = new RemoteCodingCapabilityRouterService(
          makeRuntime(),
          makeConfig({
            provider,
            remoteHttpBaseUrl: server.baseUrl,
            remoteHttpToken: "token",
            agentRunners: ["codex", "claude-code"],
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
          "/v1/processes/run",
          "/v1/processes/run",
          "/v1/processes/run",
          "/v1/processes/run",
        ]);
        expect(
          server.calls.every((call) => call.authorization === "Bearer token"),
        ).toBe(true);
        expect(server.calls.every((call) => call.redirect === "error")).toBe(
          true,
        );
      } finally {
        await server.close();
      }
    },
  );

  it("keeps the remote request deadline active through response-body consumption", async () => {
    const originalFetch = globalThis.fetch;
    let bodyWasCancelled = false;
    const fetchMock: typeof fetch = Object.assign(
      async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              signal?.addEventListener(
                "abort",
                () => {
                  bodyWasCancelled = true;
                  controller.error(signal.reason);
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: "https://remote-runner.test",
          requestTimeoutMs: 20,
        }),
      );

      await expect(service.fs.list({ path: "/repo" })).rejects.toMatchObject({
        name: "TimeoutError",
        message: expect.stringMatching(/timed out.*20ms/i),
      });
      expect(bodyWasCancelled).toBe(true);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("rejects responses whose declared length exceeds the operation cap", async () => {
    const originalFetch = globalThis.fetch;
    let bodyWasCancelled = false;
    const fetchMock: typeof fetch = Object.assign(
      async (): Promise<Response> =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array([123]));
              controller.close();
            },
            cancel() {
              bodyWasCancelled = true;
              return new Promise<void>(() => undefined);
            },
          }),
          { headers: { "content-length": "16385" } },
        ),
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: "https://remote-runner.test",
        }),
      );

      await expect(
        settleWithin(service.fs.list({ path: "/repo" })),
      ).rejects.toMatchObject({
        name: "RemoteResponseTooLargeError",
        code: "REMOTE_RESPONSE_TOO_LARGE",
      });
      expect(bodyWasCancelled).toBe(true);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("does not expose untrusted remote error bodies", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = Object.assign(
      async (): Promise<Response> =>
        new Response("secret-internal-runner-detail", { status: 500 }),
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: "https://remote-runner.test",
        }),
      );

      await expect(service.fs.list({ path: "/repo" })).rejects.toThrow(
        "Remote runner health check failed with HTTP 500.",
      );
      await expect(service.fs.list({ path: "/repo" })).rejects.not.toThrow(
        "secret-internal-runner-detail",
      );
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("does not expose transport diagnostics from the remote boundary", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = Object.assign(
      async (): Promise<Response> => {
        throw new Error("connect ECONNREFUSED 10.0.0.8:4321");
      },
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: "https://remote-runner.test",
        }),
      );

      await expect(service.fs.list({ path: "/repo" })).rejects.toThrow(
        "Remote HTTP request failed.",
      );
      await expect(service.fs.list({ path: "/repo" })).rejects.not.toThrow(
        "10.0.0.8",
      );
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("aborts a streamed response when its actual bytes exceed the cap", async () => {
    const originalFetch = globalThis.fetch;
    let bodyWasCancelled = false;
    const fetchMock: typeof fetch = Object.assign(
      async (): Promise<Response> =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(10_000));
            },
            cancel() {
              bodyWasCancelled = true;
              return new Promise<void>(() => undefined);
            },
          }),
        ),
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: "https://remote-runner.test",
        }),
      );

      await expect(
        settleWithin(service.fs.list({ path: "/repo" })),
      ).rejects.toMatchObject({ name: "RemoteResponseTooLargeError" });
      expect(bodyWasCancelled).toBe(true);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it.each([
    "file:///etc/passwd",
    "https://runner:secret@remote-runner.test",
    "https://remote-runner.test?token=secret",
  ])(
    "rejects an unsafe remote runner base URL without echoing it: %s",
    async (url) => {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: url,
        }),
      );

      const failure = service.fs.list({ path: "/repo" });
      await expect(failure).rejects.toMatchObject({
        code: expect.stringMatching(/^REMOTE_HTTP_URL_/),
      });
      await expect(failure).rejects.not.toThrow(url);
      await expect(failure).rejects.not.toThrow("secret");
    },
  );

  it("fails closed when a process response omits its exit status", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        return path === "/v1/health"
          ? jsonResponse(200, { ok: true })
          : jsonResponse(200, { stdout: "looks successful" });
      },
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: "https://remote-runner.test",
        }),
      );

      await expect(
        service.pty.runCommand({ command: "true" }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_REQUEST_FAILED",
        message: "Remote runner process response omitted exit code.",
      });
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("rejects malformed file-entry metadata instead of fabricating defaults", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        return path === "/v1/health"
          ? jsonResponse(200, { ok: true })
          : jsonResponse(200, {
              entries: [{ path: "/workspace/file", type: "file" }],
            });
      },
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "home",
          remoteHttpBaseUrl: "https://remote-runner.test",
        }),
      );

      await expect(service.fs.list({ path: "/repo" })).rejects.toMatchObject({
        code: "REMOTE_RESPONSE_SCHEMA_INVALID",
        message:
          "Remote runner fs entry size was not a non-negative safe integer.",
      });
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("applies the provisioning deadline to the initial Cloud request", async () => {
    const originalFetch = globalThis.fetch;
    let requestWasAborted = false;
    const fetchMock: typeof fetch = Object.assign(
      async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              requestWasAborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "eliza-cloud",
          remoteHttpBaseUrl: undefined,
          cloudApiBaseUrl: "https://api.eliza.app/api/v1",
          cloudApiToken: "cloud-key",
          timeoutMs: 20,
          requestTimeoutMs: 10_000,
        }),
      );

      await expect(service.fs.list({ path: "/repo" })).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(requestWasAborted).toBe(true);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("rejects a private runner authority returned by the public Cloud API", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = Object.assign(
      async (): Promise<Response> =>
        jsonResponse(201, {
          data: {
            containerId: "cloud-container-1",
            status: "running",
            url: "http://169.254.169.254/latest/meta-data",
          },
        }),
      { preconnect: originalFetch.preconnect },
    );
    replaceGlobalFetch(fetchMock);
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "eliza-cloud",
          remoteHttpBaseUrl: undefined,
          cloudApiBaseUrl: "https://api.eliza.app/api/v1",
          cloudApiToken: "cloud-key",
        }),
      );

      await expect(service.fs.list({ path: "/repo" })).rejects.toMatchObject({
        code: "CLOUD_CODING_CONTAINER_RUNNER_URL_REJECTED",
        message:
          "Eliza Cloud coding-container runner URL must use a public HTTPS authority.",
      });
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("provisions an Eliza Cloud coding container before using the remote runner HTTP contract", async () => {
    const server = startElizaCloudProvisioningServer();
    try {
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        makeConfig({
          provider: "eliza-cloud",
          remoteHttpBaseUrl: undefined,
          cloudApiBaseUrl: server.baseUrl,
          cloudApiToken: "cloud-key",
          agentRunners: ["codex", "claude-code"],
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
            HOST: "0.0.0.0",
            ELIZA_CODING_WORKSPACE: "/workspace",
            ELIZA_SANDBOX_AGENT_RUNNERS: "codex,claude-code",
          },
        },
      });
      const remoteToken = (
        provisionBody as {
          container?: { environmentVars?: Record<string, string> };
        }
      ).container?.environmentVars?.ELIZA_REMOTE_RUNNER_HTTP_TOKEN;
      expect(remoteToken).toEqual(expect.any(String));
      expect(
        server.calls
          .slice(1)
          .every((call) => call.authorization === `Bearer ${remoteToken}`),
      ).toBe(true);
      expect(server.calls.every((call) => call.redirect === "error")).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });

  it("rejects host paths outside the mapped workspace", async () => {
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(),
    );

    await expect(
      service.fs.readText({ path: "/outside/file.ts" }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it("returns timedOut from pty.runCommand when /v1/processes/run hangs before headers", async () => {
    const originalFetch = globalThis.fetch;
    replaceGlobalFetch(healthThenProcessFetch(hungFetch));
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      remoteCommandTimeoutConfig(),
    );
    const started = Date.now();
    try {
      await expect(
        service.pty.runCommand({ command: "sleep", args: ["30"] }),
      ).resolves.toMatchObject({
        timedOut: true,
        exitCode: null,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("uses an explicit command timeout instead of the configured runner default", async () => {
    const originalFetch = globalThis.fetch;
    replaceGlobalFetch(healthThenProcessFetch(hungFetch));
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig({
        provider: "home",
        remoteHttpBaseUrl: "https://remote-runner.test",
        remoteHttpToken: "token",
        timeoutMs: 5_000,
        requestTimeoutMs: 5_000,
      }),
    );
    const started = Date.now();
    try {
      await expect(
        service.pty.runCommand({
          command: "sleep",
          args: ["30"],
          timeoutMs: 50,
        }),
      ).resolves.toMatchObject({
        timedOut: true,
        exitCode: null,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("uses the configured request timeout when command options provide no timeout", async () => {
    const originalFetch = globalThis.fetch;
    replaceGlobalFetch(healthThenProcessFetch(hungFetch));
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig({
        provider: "home",
        remoteHttpBaseUrl: "https://remote-runner.test",
        remoteHttpToken: "token",
        timeoutMs: 5_000,
        requestTimeoutMs: 50,
      }),
    );
    const sandbox = await (
      service as unknown as { getRunner(): Promise<RemoteRunnerClient> }
    ).getRunner();
    const started = Date.now();
    try {
      await expect(sandbox.commands.run("sleep 30")).rejects.toMatchObject({
        name: "TimeoutError",
        message: expect.stringMatching(/timed out.*50ms/i),
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("preserves a structured timeout returned by the remote runner", async () => {
    const originalFetch = globalThis.fetch;
    replaceGlobalFetch(
      healthThenProcessFetch(async () =>
        jsonResponse(200, {
          exitCode: 124,
          stdout: "partial output",
          stderr: "command deadline reached",
          timedOut: true,
        }),
      ),
    );
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      remoteCommandTimeoutConfig(),
    );
    try {
      await expect(
        service.pty.runCommand({ command: "sleep", args: ["30"] }),
      ).resolves.toEqual({
        output: "partial output\ncommand deadline reached",
        exitCode: 124,
        timedOut: true,
      });
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("reports the timeout selected before command options are mutated", async () => {
    const originalFetch = globalThis.fetch;
    replaceGlobalFetch(healthThenProcessFetch(hungFetch));
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      makeConfig({
        provider: "home",
        remoteHttpBaseUrl: "https://remote-runner.test",
        remoteHttpToken: "token",
        timeoutMs: 5_000,
        requestTimeoutMs: 5_000,
      }),
    );
    const sandbox = await (
      service as unknown as { getRunner(): Promise<RemoteRunnerClient> }
    ).getRunner();
    const options = { requestTimeoutMs: 50 };
    try {
      const command = sandbox.commands.run("sleep 30", options);
      options.requestTimeoutMs = 5_000;
      await expect(command).rejects.toMatchObject({
        name: "TimeoutError",
        message: expect.stringMatching(/timed out.*50ms/i),
      });
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it.each([0, -1, Number.NaN, 2_147_483_648])(
    "rejects an invalid explicit command timeout without dispatching it (%s)",
    async (timeoutMs) => {
      const originalFetch = globalThis.fetch;
      let processCalls = 0;
      replaceGlobalFetch(
        healthThenProcessFetch(async () => {
          processCalls += 1;
          return jsonResponse(200, { exitCode: 0, stdout: "", stderr: "" });
        }),
      );
      const service = new RemoteCodingCapabilityRouterService(
        makeRuntime(),
        remoteCommandTimeoutConfig(),
      );
      try {
        await expect(
          service.pty.runCommand({ command: "echo", timeoutMs }),
        ).rejects.toMatchObject({
          code: "CAPABILITY_REQUEST_FAILED",
          capability: "pty",
          method: "pty.command.run",
          message: expect.stringMatching(/duration must be an integer/i),
        });
        expect(processCalls).toBe(0);
      } finally {
        replaceGlobalFetch(originalFetch);
      }
    },
  );

  it("returns timedOut from pty.runCommand when process headers arrive then the body stalls", async () => {
    const originalFetch = globalThis.fetch;
    replaceGlobalFetch(
      healthThenProcessFetch(partialBodyFetch('{"exitCode":0,"stdout":"')),
    );
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      remoteCommandTimeoutConfig(),
    );
    const started = Date.now();
    try {
      await expect(
        service.pty.runCommand({ command: "sleep", args: ["30"] }),
      ).resolves.toMatchObject({
        timedOut: true,
        exitCode: null,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });

  it("keeps a genuine pre-timeout AbortError as CapabilityError for pty.runCommand", async () => {
    const originalFetch = globalThis.fetch;
    replaceGlobalFetch(
      healthThenProcessFetch(async () => {
        throw bunAbortError();
      }),
    );
    const service = new RemoteCodingCapabilityRouterService(
      makeRuntime(),
      remoteCommandTimeoutConfig(),
    );
    try {
      await expect(
        service.pty.runCommand({ command: "echo", args: ["hi"] }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_REQUEST_FAILED",
        capability: "pty",
        method: "pty.command.run",
        message: "The operation was aborted.",
      });
    } finally {
      replaceGlobalFetch(originalFetch);
    }
  });
});
