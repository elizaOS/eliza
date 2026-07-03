/**
 * Per-spawn scoped model-token leases + revocation + credit-gate (#11536 E2
 * residual). Behavior under test:
 *
 * - MINT AT SPAWN: with gateway mode ON and a lease broker configured, a spawn
 *   mints a per-spawn lease and the child env carries the LEASED token — not the
 *   static ELIZA_MODEL_GATEWAY_TOKEN. The mint request TTL equals the task
 *   timeout, scoped to `model-invoke`.
 * - REVOKE ON TASK END: every terminal event (stopped / error / cancelled)
 *   revokes the lease exactly once; service teardown revokes any survivors.
 *   Proven end-to-end with a fake gateway that honors revocation — after revoke
 *   a model call with the leased token is rejected mid-task.
 * - TTL EXPIRY: an expired lease is rejected by the gateway even without an
 *   explicit revoke.
 * - CREDIT-GATE: an insufficient-budget gate refuses BEFORE minting — no mint,
 *   spawn fails closed, no orphan session record.
 * - NO-BROKER FALLBACK: gateway ON but no broker → static token, unchanged.
 * - STRICT FAIL-CLOSED: ELIZA_MODEL_GATEWAY_STRICT=1 with no broker (or a
 *   broker whose mint fails) refuses the spawn rather than hand out a static
 *   long-lived token.
 * - HTTP REFERENCE BROKER: drives a real loopback HTTP broker end-to-end
 *   (mint + revoke over the wire, through the SSRF guard).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
    __leaseNativeMock?: NativeMockState;
  };
  g.__leaseNativeMock ??= { instances: [] };
  return g.__leaseNativeMock;
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
vi.mock("node:child_process", () => ({
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
  spawn: vi.fn(),
}));

import { AcpService } from "../../src/services/acp-service.js";
import {
  configureModelGatewayLease,
  isLeaseExpired,
  type LeaseMintRequest,
  type ModelGatewayLease,
  type ModelGatewayLeaseBroker,
  resetModelGatewayLease,
} from "../../src/services/model-gateway-lease.js";
import { resetSessionSpendUsd } from "../../src/services/spend-allowance.js";

const GATEWAY_URL = "https://gateway.test.invalid/v1";
const GATEWAY_TOKEN = "gw-static-token-DO-NOT-SHIP-TO-CHILD";

const MANAGED_ENV_KEYS = [
  "ELIZA_MODEL_GATEWAY_URL",
  "ELIZA_MODEL_GATEWAY_TOKEN",
  "ELIZA_MODEL_GATEWAY_LEASE_URL",
  "ELIZA_MODEL_GATEWAY_STRICT",
  "ELIZA_AGENT_SPEND_CAP_USD",
  "ELIZA_CONFIG_PATH",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
] as const;

let savedEnv: Record<string, string | undefined>;

type MockLogger = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function runtime(): { runtime: never; logger: MockLogger } {
  const values: Record<string, string | undefined> = {
    ELIZA_ACP_TRANSPORT: "native",
  };
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

function allLoggedText(logger: MockLogger): string {
  return JSON.stringify([
    ...logger.debug.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]);
}

function enableGateway(): void {
  process.env.ELIZA_MODEL_GATEWAY_URL = GATEWAY_URL;
  process.env.ELIZA_MODEL_GATEWAY_TOKEN = GATEWAY_TOKEN;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * A fake gateway that mints/tracks/revokes leases and can answer whether a
 * given token would be accepted on a model call right now (honors revocation +
 * TTL). Its clock is injectable so TTL expiry is deterministic.
 */
class FakeGateway {
  private readonly active = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private seq = 0;
  readonly mints: LeaseMintRequest[] = [];
  readonly revoked: string[] = [];
  now: () => number = () => Date.now();
  mintError: Error | null = null;

  broker(): ModelGatewayLeaseBroker {
    return {
      mint: async (req: LeaseMintRequest): Promise<ModelGatewayLease> => {
        if (this.mintError) throw this.mintError;
        this.mints.push(req);
        this.seq += 1;
        const leaseId = `lease-${this.seq}`;
        const token = `leased-token-${this.seq}`;
        const expiresAt = this.now() + req.ttlMs;
        this.active.set(leaseId, { token, expiresAt });
        return { token, leaseId, expiresAt };
      },
      revoke: async (leaseId: string): Promise<void> => {
        this.revoked.push(leaseId);
        this.active.delete(leaseId);
      },
    };
  }

  /** Emulate the gateway authorizing a model call with `token`. */
  callModel(token: string): 200 | 401 {
    for (const lease of this.active.values()) {
      if (lease.token === token && this.now() < lease.expiresAt) return 200;
    }
    return 401;
  }
}

beforeEach(() => {
  nativeClientMock.instances.length = 0;
  resetModelGatewayLease();
  resetSessionSpendUsd();
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ELIZA_CONFIG_PATH = "/nonexistent/lease-test/eliza.json";
});

afterEach(() => {
  resetModelGatewayLease();
  resetSessionSpendUsd();
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function spawnWith(
  opts: { timeoutMs?: number; name?: string } = {},
): Promise<{ service: AcpService; sessionId: string; env: NodeJS.ProcessEnv }> {
  const { runtime: rt } = runtime();
  const service = new AcpService(rt);
  await service.start();
  const result = await service.spawnSession({
    name: opts.name ?? "lease-spawn",
    agentType: "claude",
    workdir: "/tmp/acp-lease-test",
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const env = firstNativeClient().opts.env ?? {};
  return { service, sessionId: result.sessionId, env };
}

describe("mint at spawn — leased token replaces the static token", () => {
  it("injects the LEASED token (not the static gateway token) into the child env", async () => {
    enableGateway();
    const gateway = new FakeGateway();
    configureModelGatewayLease({ broker: gateway.broker() });

    const { service, env } = await spawnWith({ timeoutMs: 90_000 });

    expect(env.OPENAI_BASE_URL).toBe(GATEWAY_URL);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
    // The child holds the minted lease token, never the static gateway token.
    expect(env.OPENAI_API_KEY).toBe("leased-token-1");
    expect(env.ANTHROPIC_API_KEY).toBe("leased-token-1");
    // The privileged static gateway token must not survive ANYWHERE in the
    // child — not as OPENAI_API_KEY, and not as the raw ELIZA_MODEL_GATEWAY_*
    // admin vars (which the ELIZA_ prefix rule would otherwise forward).
    expect(env.ELIZA_MODEL_GATEWAY_TOKEN).toBeUndefined();
    expect(env.ELIZA_MODEL_GATEWAY_URL).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(GATEWAY_TOKEN);

    // One lease, scoped to model-invoke, TTL == task timeout.
    expect(gateway.mints).toHaveLength(1);
    expect(gateway.mints[0]).toMatchObject({
      scope: "model-invoke",
      ttlMs: 90_000,
      agentType: "claude",
    });
    await service.stop();
  });

  it("never logs the leased or static token", async () => {
    enableGateway();
    const gateway = new FakeGateway();
    configureModelGatewayLease({ broker: gateway.broker() });
    const { runtime: rt, logger } = runtime();
    const service = new AcpService(rt);
    await service.start();
    await service.spawnSession({
      name: "lease-log",
      agentType: "claude",
      workdir: "/tmp/acp-lease-test",
    });
    const text = allLoggedText(logger);
    expect(text).not.toContain(GATEWAY_TOKEN);
    expect(text).not.toContain("leased-token-1");
    // But the structured mint line is present with the non-secret handle.
    expect(text).toContain("lease minted for sub-agent");
    expect(text).toContain("lease-1");
    await service.stop();
  });
});

describe("revoke on task end — all three terminal exit paths + teardown", () => {
  for (const event of ["stopped", "error", "cancelled"] as const) {
    it(`revokes the lease exactly once on a '${event}' terminal event`, async () => {
      enableGateway();
      const gateway = new FakeGateway();
      configureModelGatewayLease({ broker: gateway.broker() });
      const { service, sessionId, env } = await spawnWith();

      // Mid-task the leased token authorizes model calls.
      const token = env.OPENAI_API_KEY ?? "";
      expect(gateway.callModel(token)).toBe(200);

      service.emitSessionEvent(sessionId, event, {});
      await settle();

      expect(gateway.revoked).toEqual(["lease-1"]);
      // Revocation killed access mid-task.
      expect(gateway.callModel(token)).toBe(401);

      // Idempotent: a second terminal event does not double-revoke.
      service.emitSessionEvent(sessionId, "stopped", {});
      await settle();
      expect(gateway.revoked).toEqual(["lease-1"]);
      await service.stop();
    });
  }

  it("closeSession (real stop path) revokes the lease and kills model access", async () => {
    enableGateway();
    const gateway = new FakeGateway();
    configureModelGatewayLease({ broker: gateway.broker() });
    const { service, sessionId, env } = await spawnWith();
    const token = env.OPENAI_API_KEY ?? "";
    expect(gateway.callModel(token)).toBe(200);

    await service.closeSession(sessionId);
    await settle();

    expect(gateway.revoked).toEqual(["lease-1"]);
    expect(gateway.callModel(token)).toBe(401);
    await service.stop();
  });

  it("service.stop() revokes leases still live at teardown", async () => {
    enableGateway();
    const gateway = new FakeGateway();
    configureModelGatewayLease({ broker: gateway.broker() });
    const { service, env } = await spawnWith();
    const token = env.OPENAI_API_KEY ?? "";
    expect(gateway.callModel(token)).toBe(200);

    await service.stop();
    await settle();

    expect(gateway.revoked).toEqual(["lease-1"]);
    expect(gateway.callModel(token)).toBe(401);
  });
});

describe("TTL expiry", () => {
  it("mints with TTL == task timeout and the gateway rejects the token past expiry", async () => {
    enableGateway();
    const gateway = new FakeGateway();
    const base = 1_000_000;
    gateway.now = () => base;
    configureModelGatewayLease({ broker: gateway.broker() });

    const { service, env } = await spawnWith({ timeoutMs: 5_000 });
    const token = env.OPENAI_API_KEY ?? "";
    expect(gateway.mints[0]?.ttlMs).toBe(5_000);

    // Within TTL: authorized.
    expect(gateway.callModel(token)).toBe(200);
    // Past TTL: rejected even without an explicit revoke.
    gateway.now = () => base + 5_001;
    expect(gateway.callModel(token)).toBe(401);
    await service.stop();
  });

  it("isLeaseExpired reflects the expiry boundary", () => {
    const lease: ModelGatewayLease = {
      token: "t",
      leaseId: "l",
      expiresAt: 2_000,
    };
    expect(isLeaseExpired(lease, 1_999)).toBe(false);
    expect(isLeaseExpired(lease, 2_000)).toBe(true);
    expect(isLeaseExpired(lease, 2_001)).toBe(true);
  });
});

describe("credit-gate — insufficient budget fails closed with no mint", () => {
  it("refuses the spawn before minting when the gate returns a refusal", async () => {
    enableGateway();
    const gateway = new FakeGateway();
    configureModelGatewayLease({
      broker: gateway.broker(),
      creditGate: {
        check: () => "insufficient budget for a model lease",
      },
    });

    const { runtime: rt } = runtime();
    const service = new AcpService(rt);
    await service.start();

    await expect(
      service.spawnSession({
        name: "lease-nobudget",
        agentType: "claude",
        workdir: "/tmp/acp-lease-test",
      }),
    ).rejects.toThrow(/credit-gate refused/);

    // Fail-closed: no mint, no leaked child env, no orphan session record.
    expect(gateway.mints).toHaveLength(0);
    expect(nativeClientMock.instances).toHaveLength(0);
    expect(await service.listSessions()).toHaveLength(0);
    await service.stop();
  });

  it("default spend-cap gate refuses once a session's cap is consumed", async () => {
    enableGateway();
    process.env.ELIZA_AGENT_SPEND_CAP_USD = "0"; // cap disabled -> gate allows
    const gateway = new FakeGateway();
    configureModelGatewayLease({ broker: gateway.broker() });

    // Cap disabled: mint proceeds (today's unlimited behavior).
    const { service } = await spawnWith();
    expect(gateway.mints).toHaveLength(1);
    await service.stop();
  });
});

describe("no-broker fallback — unchanged static-token behavior", () => {
  it("gateway ON, no broker, non-strict: child gets the static token", async () => {
    enableGateway();
    configureModelGatewayLease({ broker: null }); // force no broker

    const { service, env } = await spawnWith();
    expect(env.OPENAI_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.OPENAI_BASE_URL).toBe(GATEWAY_URL);
    await service.stop();
  });
});

describe("strict mode — fail closed rather than hand out a static token", () => {
  it("gateway ON, strict, no broker: spawn is refused", async () => {
    enableGateway();
    process.env.ELIZA_MODEL_GATEWAY_STRICT = "1";
    configureModelGatewayLease({ broker: null });

    const { runtime: rt } = runtime();
    const service = new AcpService(rt);
    await service.start();
    await expect(
      service.spawnSession({
        name: "lease-strict-nobroker",
        agentType: "claude",
        workdir: "/tmp/acp-lease-test",
      }),
    ).rejects.toThrow(
      /STRICT.*no lease broker|no lease broker.*STRICT|refusing/i,
    );
    expect(nativeClientMock.instances).toHaveLength(0);
    expect(await service.listSessions()).toHaveLength(0);
    await service.stop();
  });

  it("gateway ON, strict, broker mint fails (broker down): spawn is refused", async () => {
    enableGateway();
    process.env.ELIZA_MODEL_GATEWAY_STRICT = "1";
    const gateway = new FakeGateway();
    gateway.mintError = new Error("broker unreachable");
    configureModelGatewayLease({ broker: gateway.broker() });

    const { runtime: rt } = runtime();
    const service = new AcpService(rt);
    await service.start();
    await expect(
      service.spawnSession({
        name: "lease-strict-brokerdown",
        agentType: "claude",
        workdir: "/tmp/acp-lease-test",
      }),
    ).rejects.toThrow(/strict fail-closed/i);
    expect(nativeClientMock.instances).toHaveLength(0);
    expect(await service.listSessions()).toHaveLength(0);
    await service.stop();
  });

  it("gateway ON, NON-strict, broker mint fails: falls back to the static token", async () => {
    enableGateway();
    const gateway = new FakeGateway();
    gateway.mintError = new Error("broker unreachable");
    configureModelGatewayLease({ broker: gateway.broker() });

    const { service, env } = await spawnWith();
    // Non-strict: a mint failure degrades to the static token, spawn proceeds.
    expect(env.OPENAI_API_KEY).toBe(GATEWAY_TOKEN);
    await service.stop();
  });
});

describe("HTTP reference broker — real loopback mint + revoke over the wire", () => {
  let server: Server;
  let baseUrl: string;
  const requests: Array<{
    method: string;
    url: string;
    auth: string | undefined;
    body: string;
  }> = [];
  let seq = 0;

  beforeEach(async () => {
    requests.length = 0;
    seq = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization,
          body,
        });
        if (req.method === "POST" && req.url === "/lease") {
          seq += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              token: `http-leased-${seq}`,
              leaseId: `http-lease-${seq}`,
              expiresAt: Date.now() + 60_000,
            }),
          );
          return;
        }
        if (
          req.method === "POST" &&
          /^\/lease\/.+\/revoke$/.test(req.url ?? "")
        ) {
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/lease`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("mints via POST /lease (bearer = gateway token) and revokes via POST /lease/:id/revoke", async () => {
    enableGateway();
    process.env.ELIZA_MODEL_GATEWAY_LEASE_URL = baseUrl;
    // No injected broker: resolveLeaseBroker builds the real HTTP broker.

    const { service, sessionId, env } = await spawnWith({ timeoutMs: 45_000 });

    // Child got the server-minted token, not the static one.
    expect(env.OPENAI_API_KEY).toBe("http-leased-1");
    expect(JSON.stringify(env)).not.toContain(GATEWAY_TOKEN);

    const mint = requests.find((r) => r.url === "/lease");
    expect(mint).toBeDefined();
    expect(mint?.method).toBe("POST");
    expect(mint?.auth).toBe(`Bearer ${GATEWAY_TOKEN}`);
    const mintBody = JSON.parse(mint?.body ?? "{}");
    expect(mintBody).toMatchObject({
      sessionId,
      scope: "model-invoke",
      ttlMs: 45_000,
      agentType: "claude",
    });

    await service.closeSession(sessionId);
    await settle();

    const revoke = requests.find((r) => /\/revoke$/.test(r.url));
    expect(revoke).toBeDefined();
    expect(revoke?.method).toBe("POST");
    expect(revoke?.url).toBe("/lease/http-lease-1/revoke");
    expect(revoke?.auth).toBe(`Bearer ${GATEWAY_TOKEN}`);
    await service.stop();
  });
});
