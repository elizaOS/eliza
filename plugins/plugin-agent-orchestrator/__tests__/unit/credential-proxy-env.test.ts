/**
 * Credential-proxy mode for spawned coding sub-agents (#11536 E3).
 *
 * Contract under test:
 * - resolveOrchestratorCredentialProxyConfig gates on BOTH URL + TOKEN.
 * - applyCredentialProxyEnv deletes every raw VCS PAT, injects the proxy config
 *   + a git credential helper, and (strict mode) refuses when a raw PAT is
 *   present in the parent env.
 * - Through the REAL AcpService.buildEnv spawn seam, the child env in proxy
 *   mode contains no raw PAT and does carry the helper wiring.
 * - The materialized git credential helper, run by the REAL node binary against
 *   a REAL (mock) proxy HTTP server, returns broker-minted credentials with a
 *   valid HMAC signature and no PAT — and fails closed for off-allowlist hosts.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  buildCredentialProxyCanonicalString,
  credentialProxyBodyHash,
  signCredentialProxyRequest,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpJsonRpcMessage,
  ApprovalPreset,
} from "../../src/services/types.js";

type NativeEventHandler = (
  event: AcpJsonRpcMessage,
  sessionId?: string,
) => void;
type NativeOptions = {
  command: string;
  cwd: string;
  approvalPreset: ApprovalPreset;
  timeoutMs?: number;
  terminal?: boolean;
  env?: NodeJS.ProcessEnv;
  onEvent?: NativeEventHandler;
  onStderr?: (chunk: string) => void;
};
type MockNativeClient = {
  opts: NativeOptions;
  eventHandler?: NativeEventHandler;
  start: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setEventHandler: (handler: NativeEventHandler | undefined) => void;
  setTimeoutMs: (timeoutMs: number | undefined) => void;
};
type NativeMockState = {
  NativeAcpClient?: new (opts: NativeOptions) => MockNativeClient;
  instances: MockNativeClient[];
};

function getNativeMockState(): NativeMockState {
  const g = globalThis as typeof globalThis & {
    __credProxyNativeMock?: NativeMockState;
  };
  g.__credProxyNativeMock ??= { instances: [] };
  return g.__credProxyNativeMock;
}

const nativeClientMock = getNativeMockState();

vi.mock("../../src/services/acp-native-transport.js", () => {
  const state = getNativeMockState();
  state.NativeAcpClient = class MockNativeAcpClient
    implements MockNativeClient
  {
    opts: NativeOptions;
    eventHandler?: NativeEventHandler;
    start = vi.fn(async () => undefined);
    createSession = vi.fn(async () => ({
      sessionId: "protocol-session",
      agentSessionId: "agent-session",
    }));
    prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    cancel = vi.fn(async () => undefined);
    closeSession = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    constructor(opts: NativeOptions) {
      this.opts = opts;
      this.eventHandler = opts.onEvent;
      getNativeMockState().instances.push(this);
    }
    setEventHandler(handler: NativeEventHandler | undefined) {
      this.eventHandler = handler;
      this.opts.onEvent = handler;
    }
    setTimeoutMs(timeoutMs: number | undefined) {
      this.opts.timeoutMs = timeoutMs;
    }
  };
  return { NativeAcpClient: state.NativeAcpClient };
});

// Baseline git capture uses execFile; make it a no-op so spawns don't hang.
// The REAL `spawn` is preserved for the end-to-end helper test below.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: vi.fn(),
    execFile: vi.fn(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const callback = typeof _opts === "function" ? _opts : cb;
        if (typeof callback === "function") {
          callback(new Error("git unavailable in test"), "", "");
        }
      },
    ),
    execFileSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  };
});

import { AcpService } from "../../src/services/acp-service.js";
import {
  _resetCredentialProxyHelperCache,
  applyCredentialProxyEnv,
  CREDENTIAL_PROXY_GIT_HOSTS_KEY,
  GIT_CREDENTIAL_PROXY_HELPER_SOURCE,
  materializeGitCredentialHelper,
  resolveOrchestratorCredentialProxyConfig,
} from "../../src/services/credential-proxy-env.js";

const PROXY_URL = "https://cred-proxy.test.invalid/broker";
const PROXY_TOKEN = "agent-scoped-handle-xyz";
const SIGNING_KEY = "shared-hmac-secret";
const RAW_PAT = "ghp_RAW_PAT_DO_NOT_LEAK_0123456789";

const MANAGED_ENV_KEYS = [
  "ELIZA_CREDENTIAL_PROXY_URL",
  "ELIZA_CREDENTIAL_PROXY_TOKEN",
  "ELIZA_CREDENTIAL_PROXY_SIGNING_KEY",
  "ELIZA_CREDENTIAL_PROXY_STRICT",
  "ELIZA_CREDENTIAL_PROXY_ROUTES",
  "ELIZA_CONFIG_PATH",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
] as const;

let savedEnv: Record<string, string | undefined>;

type MockLogger = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function runtime(settings: Record<string, string | undefined> = {}) {
  const values = { ELIZA_ACP_TRANSPORT: "native", ...settings };
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    runtime: {
      logger,
      getSetting: vi.fn((key: string) => values[key]),
      services: new Map<string, unknown[]>(),
    } as never,
    logger,
  };
}

function firstNativeClient(): MockNativeClient {
  const client = nativeClientMock.instances[0];
  if (!client) throw new Error("expected NativeAcpClient to be constructed");
  return client;
}

function enableProxy(strict = false): void {
  process.env.ELIZA_CREDENTIAL_PROXY_URL = PROXY_URL;
  process.env.ELIZA_CREDENTIAL_PROXY_TOKEN = PROXY_TOKEN;
  process.env.ELIZA_CREDENTIAL_PROXY_SIGNING_KEY = SIGNING_KEY;
  if (strict) process.env.ELIZA_CREDENTIAL_PROXY_STRICT = "1";
}

async function spawnAndCaptureEnv(): Promise<NodeJS.ProcessEnv> {
  const { runtime: rt } = runtime();
  const service = new AcpService(rt);
  await service.start();
  await service.spawnSession({
    name: "codex-cp",
    agentType: "codex",
    workdir: "/tmp/acp-cp-test",
  });
  const env = firstNativeClient().opts.env ?? {};
  await service.stop();
  return env;
}

beforeEach(() => {
  nativeClientMock.instances.length = 0;
  _resetCredentialProxyHelperCache();
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ELIZA_CONFIG_PATH = "/nonexistent/cred-proxy-test/eliza.json";
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveOrchestratorCredentialProxyConfig (mode gate)", () => {
  it("is ON only when both URL + TOKEN are set", () => {
    expect(resolveOrchestratorCredentialProxyConfig()).toBeUndefined();
    process.env.ELIZA_CREDENTIAL_PROXY_URL = PROXY_URL;
    expect(resolveOrchestratorCredentialProxyConfig()).toBeUndefined();
    process.env.ELIZA_CREDENTIAL_PROXY_TOKEN = PROXY_TOKEN;
    const cfg = resolveOrchestratorCredentialProxyConfig();
    expect(cfg?.url).toBe(PROXY_URL);
    expect(cfg?.token).toBe(PROXY_TOKEN);
  });
});

describe("applyCredentialProxyEnv (pure env rewrite)", () => {
  it("deletes raw PATs and injects proxy config + git helper wiring", () => {
    enableProxy();
    const cfg = resolveOrchestratorCredentialProxyConfig();
    if (!cfg) throw new Error("expected proxy config");
    const env: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: RAW_PAT,
      GH_TOKEN: RAW_PAT,
      PATH: "/usr/bin",
    };
    applyCredentialProxyEnv(env, cfg, "/opt/node");

    const dump = JSON.stringify(env);
    expect(dump).not.toContain(RAW_PAT);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ELIZA_CREDENTIAL_PROXY_URL).toBe(PROXY_URL);
    expect(env.ELIZA_CREDENTIAL_PROXY_TOKEN).toBe(PROXY_TOKEN);
    expect(env.ELIZA_CREDENTIAL_PROXY_SIGNING_KEY).toBe(SIGNING_KEY);
    expect(env[CREDENTIAL_PROXY_GIT_HOSTS_KEY]).toBe(
      "github.com,api.github.com",
    );
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toContain("'/opt/node'");
    expect(env.GIT_CONFIG_VALUE_1).toContain("git-credential-proxy-helper.mjs");
  });

  it("strict mode throws when a raw PAT is present in the scanned env", () => {
    enableProxy(true);
    const cfg = resolveOrchestratorCredentialProxyConfig();
    if (!cfg) throw new Error("expected proxy config");
    expect(cfg.strict).toBe(true);
    expect(() =>
      applyCredentialProxyEnv({}, cfg, "/opt/node", {
        strictScanEnv: { GITHUB_TOKEN: RAW_PAT },
      }),
    ).toThrow(/GITHUB_TOKEN/);
  });

  it("non-strict mode does not throw; it just scrubs", () => {
    enableProxy(false);
    const cfg = resolveOrchestratorCredentialProxyConfig();
    if (!cfg) throw new Error("expected proxy config");
    const env: NodeJS.ProcessEnv = { GH_TOKEN: RAW_PAT };
    expect(() => applyCredentialProxyEnv(env, cfg, "/opt/node")).not.toThrow();
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe("AcpService.buildEnv (real spawn seam)", () => {
  it("child env in proxy mode carries no raw PAT and has the helper wiring", async () => {
    enableProxy();
    // A PAT on the box must never reach the child, and (non-strict) must not
    // block the spawn.
    process.env.GITHUB_TOKEN = RAW_PAT;
    const env = await spawnAndCaptureEnv();
    expect(JSON.stringify(env)).not.toContain(RAW_PAT);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ELIZA_CREDENTIAL_PROXY_URL).toBe(PROXY_URL);
    expect(env.GIT_CONFIG_VALUE_1).toContain("git-credential-proxy-helper.mjs");
  });

  it("strict mode refuses to spawn when a raw PAT is on the box", async () => {
    enableProxy(true);
    process.env.GITHUB_TOKEN = RAW_PAT;
    const { runtime: rt } = runtime();
    const service = new AcpService(rt);
    await service.start();
    await expect(
      service.spawnSession({
        name: "codex-strict",
        agentType: "codex",
        workdir: "/tmp/acp-cp-strict",
      }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
    await service.stop();
  });
});

describe("git credential helper (signing lockstep with core)", () => {
  it("materializes an executable helper and produces the core canonical signature", () => {
    const helperPath = materializeGitCredentialHelper();
    const onDisk = readFileSync(helperPath, "utf8");
    expect(onDisk).toBe(GIT_CREDENTIAL_PROXY_HELPER_SOURCE);

    // The helper hard-codes the same canonical scheme as core. Recompute the
    // signature the helper would emit for a fixed request and assert it equals
    // core's signCredentialProxyRequest — the lockstep guard.
    const body = JSON.stringify({
      host: "github.com",
      protocol: "https",
      path: "o/r",
    });
    const canonical = buildCredentialProxyCanonicalString({
      method: "POST",
      targetHost: "github.com",
      pathAndSearch: "/git-credential",
      timestamp: "1700000000",
      bodyHash: credentialProxyBodyHash(new TextEncoder().encode(body)),
    });
    const helperSig = `v1=${createHmac("sha256", SIGNING_KEY).update(canonical).digest("hex")}`;
    expect(helperSig).toBe(signCredentialProxyRequest(SIGNING_KEY, canonical));
  });
});

// --- end-to-end: real node runs the helper against a real mock proxy --------
type ProxyRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

function startMockProxy(): Promise<{
  server: Server;
  origin: string;
  received: ProxyRequest[];
}> {
  const received: ProxyRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        if (req.url !== "/git-credential" || req.method !== "POST") {
          res.writeHead(404).end();
          return;
        }
        received.push({ headers: req.headers, body: raw });
        // Verify the HMAC signature the helper sent.
        const parsed = JSON.parse(raw) as { host: string };
        const canonical = buildCredentialProxyCanonicalString({
          method: "POST",
          targetHost: parsed.host,
          pathAndSearch: "/git-credential",
          timestamp: String(req.headers["x-eliza-proxy-timestamp"]),
          bodyHash: credentialProxyBodyHash(new TextEncoder().encode(raw)),
        });
        const expected = signCredentialProxyRequest(SIGNING_KEY, canonical);
        if (req.headers["x-eliza-proxy-signature"] !== expected) {
          res.writeHead(401).end("bad signature");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            username: "x-access-token",
            password: "broker-minted-ephemeral-token",
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}`, received });
    });
  });
}

function runHelper(
  helperPath: string,
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helperPath, "get"], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("git credential helper (real end-to-end against a mock proxy)", () => {
  it("returns broker-minted credentials with a valid signature and no PAT", async () => {
    const { server, origin, received } = await startMockProxy();
    try {
      const helperPath = materializeGitCredentialHelper();
      const result = await runHelper(
        helperPath,
        {
          ELIZA_CREDENTIAL_PROXY_URL: origin,
          ELIZA_CREDENTIAL_PROXY_TOKEN: PROXY_TOKEN,
          ELIZA_CREDENTIAL_PROXY_SIGNING_KEY: SIGNING_KEY,
          ELIZA_CREDENTIAL_PROXY_GIT_HOSTS: "github.com,api.github.com",
        },
        "protocol=https\nhost=github.com\npath=o/r\n\n",
      );
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("username=x-access-token");
      expect(result.stdout).toContain("password=broker-minted-ephemeral-token");
      // The proxy received the scoped handle, never a raw PAT.
      expect(received).toHaveLength(1);
      expect(received[0].headers.authorization).toBe(`Bearer ${PROXY_TOKEN}`);
      expect(JSON.stringify(received[0].headers)).not.toContain(RAW_PAT);
    } finally {
      server.close();
    }
  });

  it("fails closed for an off-allowlist host (no proxy call, non-zero exit)", async () => {
    const { server, origin, received } = await startMockProxy();
    try {
      const helperPath = materializeGitCredentialHelper();
      const result = await runHelper(
        helperPath,
        {
          ELIZA_CREDENTIAL_PROXY_URL: origin,
          ELIZA_CREDENTIAL_PROXY_TOKEN: PROXY_TOKEN,
          ELIZA_CREDENTIAL_PROXY_SIGNING_KEY: SIGNING_KEY,
          ELIZA_CREDENTIAL_PROXY_GIT_HOSTS: "github.com",
        },
        "protocol=https\nhost=evil.example.com\npath=o/r\n\n",
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("allowlist");
      expect(received).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});
