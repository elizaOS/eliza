/**
 * Exercises the health/status/runtime introspection routes against the real
 * handler: the /api/health package-smoke nonce echo the packaged-runtime
 * verifier depends on (packages/scripts/verify-packaged-cli.mjs injects
 * ELIZA_PACKAGE_SMOKE_NONCE and requires the payload to echo it, so an
 * unrelated healthy server on the probe port can never satisfy a smoke),
 * /api/status degradation, /api/health subsystem summaries, and the
 * /api/runtime reflective snapshot with its parameter clamps, memoization,
 * and serializer edge cases.
 */
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeCanRespond,
  type HealthRouteState,
  handleHealthRoutes,
} from "./health-routes";

type JsonPayload = Record<string, unknown> & {
  verificationNonce?: string;
};

function baseState(
  overrides: Partial<HealthRouteState> = {},
): HealthRouteState {
  return {
    runtime: null,
    config: {},
    agentState: "running",
    agentName: "test-agent",
    model: undefined,
    startedAt: Date.now(),
    startup: { phase: "ready", attempt: 1 },
    plugins: [],
    pendingRestartReasons: [],
    connectorHealthMonitor: null,
    ...overrides,
  } as HealthRouteState;
}

interface RouteResult {
  handled: boolean;
  payload?: JsonPayload;
  status?: number;
  errorMessage?: string;
  errorStatus?: number;
}

async function callRoute(
  pathname: string,
  {
    search = "",
    state = baseState(),
    method = "GET",
  }: {
    search?: string;
    state?: HealthRouteState;
    method?: string;
  } = {},
): Promise<RouteResult> {
  const result: RouteResult = { handled: false };
  result.handled = await handleHealthRoutes({
    res: {},
    method,
    pathname,
    url: new URL(`http://127.0.0.1${pathname}${search}`),
    state,
    json: (_res: unknown, body: unknown, status?: number) => {
      result.payload = body as JsonPayload;
      result.status = status;
    },
    error: (_res: unknown, message: string, status?: number) => {
      result.errorMessage = message;
      result.errorStatus = status;
    },
  } as unknown as Parameters<typeof handleHealthRoutes>[0]);
  return result;
}

async function healthResponse(): Promise<JsonPayload> {
  const { handled, payload } = await callRoute("/api/health");
  expect(handled).toBe(true);
  if (!payload) throw new Error("health route did not write a JSON payload");
  return payload;
}

const previousNonce = process.env.ELIZA_PACKAGE_SMOKE_NONCE;

afterEach(() => {
  if (previousNonce === undefined) {
    delete process.env.ELIZA_PACKAGE_SMOKE_NONCE;
  } else {
    process.env.ELIZA_PACKAGE_SMOKE_NONCE = previousNonce;
  }
});

describe("GET /api/health package-smoke nonce", () => {
  it("omits verificationNonce outside package verification", async () => {
    delete process.env.ELIZA_PACKAGE_SMOKE_NONCE;
    const payload = await healthResponse();
    expect(payload.verificationNonce).toBeUndefined();
    expect("verificationNonce" in payload).toBe(false);
  });

  it("echoes the injected nonce so the verifier can prove process identity", async () => {
    process.env.ELIZA_PACKAGE_SMOKE_NONCE = "package-proof-nonce";
    const payload = await healthResponse();
    expect(payload.verificationNonce).toBe("package-proof-nonce");
  });
});

describe("GET /api/status", () => {
  it("reports state and degrades optional cloud/local-model info instead of erroring", async () => {
    delete process.env.ELIZA_PACKAGE_SMOKE_NONCE;
    const { handled, payload } = await callRoute("/api/status", {
      state: baseState({
        model: "test-model",
        pendingRestartReasons: ["setting ELIZA_FOO changed"],
      }),
    });
    expect(handled).toBe(true);
    expect(payload).toMatchObject({
      state: "running",
      agentName: "test-agent",
      model: "test-model",
      canRespond: false,
      pendingRestart: true,
      pendingRestartReasons: ["setting ELIZA_FOO changed"],
    });
    expect(typeof payload?.uptime).toBe("number");
    // No cloud plugin/key in this harness: the status must still answer with
    // the designed disconnected shape, never a 500.
    expect(payload?.cloud).toMatchObject({
      connectionStatus: "disconnected",
      activeAgentId: null,
    });
  });

  it("does not handle non-GET methods", async () => {
    const { handled } = await callRoute("/api/status", { method: "POST" });
    expect(handled).toBe(false);
  });

  it("returns false for unrelated paths so other routers can claim them", async () => {
    const { handled } = await callRoute("/api/agents");
    expect(handled).toBe(false);
  });
});

describe("GET /api/health subsystem summary", () => {
  it("summarizes plugin failures and configured connectors without a runtime", async () => {
    delete process.env.ELIZA_PACKAGE_SMOKE_NONCE;
    const { handled, payload } = await callRoute("/api/health", {
      state: baseState({
        agentState: "starting",
        plugins: [
          { enabled: true, configured: true },
          { enabled: true, configured: true, loadError: "boom" },
          { enabled: false, configured: false },
        ],
        config: {
          connectors: {
            discord: { enabled: true },
            telegram: { enabled: false },
            slack: {},
          },
        } as HealthRouteState["config"],
      }),
    });
    expect(handled).toBe(true);
    expect(payload).toMatchObject({
      ready: false,
      runtime: "not_initialized",
      database: "unknown",
      agentState: "starting",
      plugins: { loaded: 2, failed: 1 },
      coordinator: "not_wired",
    });
    // Disabled connectors must not read as configured.
    expect(payload?.connectors).toEqual({
      discord: "configured",
      slack: "configured",
    });
    expect(payload?.deferredBoot).toBeDefined();
  });
});

describe("computeCanRespond", () => {
  const respondingRuntime = {
    getModel: (key: string) =>
      key === "TEXT_LARGE" ? () => "generated" : undefined,
  } as unknown as AgentRuntime;

  it("requires a live runtime AND running state AND a text handler", () => {
    expect(computeCanRespond(null, "running")).toBe(false);
    expect(computeCanRespond(respondingRuntime, "starting")).toBe(false);
    expect(computeCanRespond(respondingRuntime, "running")).toBe(true);
  });

  it("treats a runtime whose model registry throws as not-respondable", () => {
    const broken = {
      getModel: () => {
        throw new Error("registry offline");
      },
    } as unknown as AgentRuntime;
    expect(computeCanRespond(broken, "running")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/runtime — reflective debug snapshot
// ---------------------------------------------------------------------------

class FakeService {
  name = "worker-1";
  constructor(readonly payload: unknown) {}
}

/** A runtime-shaped object graph exercising every serializer branch. */
function fakeRuntime(): AgentRuntime {
  const circular: Record<string, unknown> = { label: "circular-holder" };
  circular.self = circular;
  const exotic = {
    when: new Date("2026-01-02T03:04:05.000Z"),
    pattern: /health-[a-z]+/gi,
    failure: Object.assign(new Error("primary failure"), {
      cause: new Error("root cause"),
    }),
    raw: Buffer.from("binary-payload"),
    typed: new Uint8Array([1, 2, 3, 4]),
    arrayBuffer: new ArrayBuffer(8),
    big: 12345678901234567890n,
    tag: Symbol("marker"),
    nothing: undefined,
    notANumber: Number.NaN,
    weak: new WeakMap(),
    weakSet: new WeakSet(),
    eventually: Promise.resolve("later"),
    lookup: new Map<string, unknown>([["alpha", { nested: true }]]),
    unique: new Set(["one", "two"]),
    long: "x".repeat(9000),
    wide: Array.from({ length: 1500 }, (_, i) => i),
    circular,
    compute: function namedComputation(a: number, b: number) {
      return a + b;
    },
    get dynamic() {
      return "accessor-value";
    },
  };
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: { name: "Testa" },
    plugins: [{ name: "plugin-alpha" }],
    actions: [{ name: "ACTION_ALPHA" }],
    providers: [{ name: "PROVIDER_ALPHA" }, { name: "PROVIDER_BETA" }],
    evaluators: [],
    services: new Map([["worker", [new FakeService(exotic)]]]),
    getModel: () => undefined,
  } as unknown as AgentRuntime;
}

describe("GET /api/runtime", () => {
  it("answers without a runtime and clamps serialize settings to their bounds", async () => {
    const { handled, payload } = await callRoute("/api/runtime", {
      search:
        "?depth=999&maxArrayLength=0&maxObjectEntries=garbage&maxStringLength=1",
    });
    expect(handled).toBe(true);
    expect(payload).toMatchObject({
      runtimeAvailable: false,
      settings: {
        maxDepth: 24, // capped
        maxArrayLength: 1, // floored
        maxObjectEntries: 1000, // non-numeric input falls back to the default
        maxStringLength: 64, // floored
      },
      meta: { pluginCount: 0, actionCount: 0 },
    });
  });

  it("serializes the runtime object graph with typed markers for exotic values", async () => {
    const runtime = fakeRuntime();
    const { handled, payload } = await callRoute("/api/runtime", {
      state: baseState({ runtime }),
    });
    expect(handled).toBe(true);
    expect(payload).toMatchObject({
      runtimeAvailable: true,
      meta: {
        agentName: "Testa",
        pluginCount: 1,
        actionCount: 1,
        providerCount: 2,
        evaluatorCount: 0,
        serviceTypeCount: 1,
        serviceCount: 1,
      },
    });

    const order = payload?.order as {
      providers: Array<{ name: string }>;
      services: Array<{ serviceType: string; count: number }>;
    };
    expect(order.providers.map((p) => p.name)).toEqual([
      "PROVIDER_ALPHA",
      "PROVIDER_BETA",
    ]);
    expect(order.services).toEqual([
      expect.objectContaining({ serviceType: "worker", count: 1 }),
    ]);

    const serialized = JSON.stringify(payload?.sections);
    for (const marker of [
      '"__type":"date"',
      '"__type":"regexp"',
      '"__type":"error"',
      '"__type":"buffer"',
      '"__type":"Uint8Array"',
      '"__type":"array-buffer"',
      '"__type":"bigint"',
      '"__type":"symbol"',
      '"__type":"undefined"',
      '"__type":"function"',
      '"__type":"weak-map"',
      '"__type":"weak-set"',
      '"__type":"promise"',
      '"__type":"map"',
      '"__type":"set"',
      '"__type":"circular"',
      '"__type":"accessor"',
      '"truncated":true', // the 9000-char string exceeds maxStringLength
      '"truncatedItems":500', // the 1500-item array exceeds maxArrayLength 1000
      '"value":"NaN"',
    ]) {
      expect(serialized).toContain(marker);
    }
  });

  it("memoizes the snapshot per options while the runtime identity is stable", async () => {
    const runtime = fakeRuntime();
    const state = baseState({ runtime });
    const first = await callRoute("/api/runtime", { state });
    const second = await callRoute("/api/runtime", { state });
    // Same payload object (not merely equal): served from the TTL cache.
    expect(second.payload).toBe(first.payload);

    const otherOptions = await callRoute("/api/runtime", {
      state,
      search: "?depth=3",
    });
    expect(otherOptions.payload).not.toBe(first.payload);

    // A swapped runtime (restart) must invalidate the cached snapshot.
    const swapped = await callRoute("/api/runtime", {
      state: baseState({ runtime: fakeRuntime() }),
    });
    expect(swapped.payload).not.toBe(first.payload);
  });

  it("translates a snapshot build failure into a 500 instead of crashing", async () => {
    const broken = {
      agentId: "broken",
      character: { name: "Broken" },
      plugins: [],
      actions: [],
      providers: [],
      evaluators: [],
      // Not a Map: Array.from(servicesMap.values()) throws inside the build.
      services: {},
    } as unknown as AgentRuntime;
    const { handled, payload, errorMessage, errorStatus } = await callRoute(
      "/api/runtime",
      { state: baseState({ runtime: broken }), search: "?depth=2" },
    );
    expect(handled).toBe(true);
    expect(payload).toBeUndefined();
    expect(errorStatus).toBe(500);
    expect(errorMessage).toContain("Failed to build runtime debug snapshot");
  });
});
