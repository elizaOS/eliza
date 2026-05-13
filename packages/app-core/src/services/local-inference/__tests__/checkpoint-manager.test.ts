/**
 * Unit tests for the top-level `GatedCheckpointManager`. Exercises:
 *
 *   - Feature flag gating (constructor option AND env var precedence).
 *   - Capability detection caching + force-reprobe.
 *   - Named-handle registry with TTL eviction.
 *   - REST URL/method assertions via fetch stub.
 *   - Cancel-fallback path (`SseDisconnectFn` when gate off).
 *
 * NO real llama-server. NO model loads. Pure fetch mocking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CTX_CHECKPOINTS_ENV_VAR,
  GatedCheckpointManager,
  readCtxCheckpointsEnvFlag,
} from "../checkpoint-manager";
import type { CheckpointFetch } from "../dflash-checkpoint-client";

interface Recorded {
  url: string;
  method: string | undefined;
}

/**
 * Build a `CheckpointFetch` that records every call. `respond` decides the
 * response per URL — default 200 with `{}` body. Override to simulate
 * capability-probe miss (404) etc.
 */
function makeFetch(
  recorded: Recorded[],
  respond: (url: string) => {
    ok: boolean;
    status: number;
    statusText: string;
    body: string;
  } = () => ({ ok: true, status: 200, statusText: "OK", body: "{}" }),
): CheckpointFetch {
  return async (url, init) => {
    recorded.push({ url: String(url), method: init?.method });
    const r = respond(String(url));
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      async text() {
        return r.body;
      },
    };
  };
}

describe("readCtxCheckpointsEnvFlag", () => {
  const orig = process.env[CTX_CHECKPOINTS_ENV_VAR];
  afterEach(() => {
    if (orig === undefined) delete process.env[CTX_CHECKPOINTS_ENV_VAR];
    else process.env[CTX_CHECKPOINTS_ENV_VAR] = orig;
  });

  it("reads 1/true/yes as on", () => {
    for (const v of ["1", "true", "yes", "TRUE", "Yes"]) {
      process.env[CTX_CHECKPOINTS_ENV_VAR] = v;
      expect(readCtxCheckpointsEnvFlag()).toBe(true);
    }
  });

  it("treats absent / empty / falsy as off", () => {
    delete process.env[CTX_CHECKPOINTS_ENV_VAR];
    expect(readCtxCheckpointsEnvFlag()).toBe(false);
    process.env[CTX_CHECKPOINTS_ENV_VAR] = "";
    expect(readCtxCheckpointsEnvFlag()).toBe(false);
    process.env[CTX_CHECKPOINTS_ENV_VAR] = "0";
    expect(readCtxCheckpointsEnvFlag()).toBe(false);
    process.env[CTX_CHECKPOINTS_ENV_VAR] = "false";
    expect(readCtxCheckpointsEnvFlag()).toBe(false);
  });
});

describe("GatedCheckpointManager — flag OFF", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("save/restore/erase short-circuit without touching fetch", async () => {
    const recorded: Recorded[] = [];
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: false,
      fetchImpl: makeFetch(recorded),
    });
    expect(mgr.isFeatureFlagOn()).toBe(false);
    expect(mgr.isEnabled()).toBe(false);
    const handle = await mgr.save(3, "n1");
    expect(handle).toBeNull();
    expect(await mgr.restore(3, "n1")).toBe(false);
    await mgr.erase(3, "n1");
    expect(recorded).toHaveLength(0);
  });

  it("cancel falls back to the SSE-disconnect callback", async () => {
    const recorded: Recorded[] = [];
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: false,
      fetchImpl: makeFetch(recorded),
    });
    const sse = vi.fn();
    await mgr.cancel(7, sse);
    expect(sse).toHaveBeenCalledWith(7);
    expect(recorded).toHaveLength(0);
  });

  it("detectCapability returns false without probing", async () => {
    const recorded: Recorded[] = [];
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: false,
      fetchImpl: makeFetch(recorded),
    });
    expect(await mgr.detectCapability()).toBe(false);
    expect(recorded).toHaveLength(0);
  });
});

describe("GatedCheckpointManager — flag ON, capability probe", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("probe returns false when /health 404s; manager stays disabled", async () => {
    const recorded: Recorded[] = [];
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: true,
      fetchImpl: makeFetch(recorded, (url) =>
        url.endsWith("/health")
          ? { ok: false, status: 404, statusText: "Not Found", body: "" }
          : { ok: true, status: 200, statusText: "OK", body: "{}" },
      ),
    });
    expect(await mgr.detectCapability()).toBe(false);
    expect(mgr.isEnabled()).toBe(false);
    // Subsequent save/restore are no-ops because the gate is half-open.
    expect(await mgr.save(1, "n1")).toBeNull();
  });

  it("probe returns true when /health advertises slot_save_path; manager enables", async () => {
    const recorded: Recorded[] = [];
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: true,
      fetchImpl: makeFetch(recorded, (url) =>
        url.endsWith("/health")
          ? {
              ok: true,
              status: 200,
              statusText: "OK",
              body: JSON.stringify({ slot_save_path: "/tmp/slots" }),
            }
          : { ok: true, status: 200, statusText: "OK", body: "{}" },
      ),
    });
    expect(await mgr.detectCapability()).toBe(true);
    expect(mgr.isEnabled()).toBe(true);
  });

  it("caches the probe result; force=true re-probes", async () => {
    const recorded: Recorded[] = [];
    let healthHits = 0;
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: true,
      fetchImpl: makeFetch(recorded, (url) => {
        if (url.endsWith("/health")) {
          healthHits++;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: JSON.stringify({ slot_save_path: "/x" }),
          };
        }
        return { ok: true, status: 200, statusText: "OK", body: "{}" };
      }),
    });
    await mgr.detectCapability();
    await mgr.detectCapability();
    expect(healthHits).toBe(1);
    await mgr.detectCapability(true);
    expect(healthHits).toBe(2);
  });

  it("setBaseUrl clears the capability cache", async () => {
    let healthHits = 0;
    const fetchImpl: CheckpointFetch = async (url) => {
      if (String(url).endsWith("/health")) healthHits++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify({ slot_save_path: "/x" });
        },
      };
    };
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: true,
      fetchImpl,
    });
    await mgr.detectCapability();
    mgr.setBaseUrl("http://127.0.0.1:9998");
    await mgr.detectCapability();
    expect(healthHits).toBe(2);
  });
});

describe("GatedCheckpointManager — REST round trip when enabled", () => {
  function makeEnabledMgr(recorded: Recorded[]): GatedCheckpointManager {
    return new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: true,
      resolveSlotId: () => 4,
      fetchImpl: makeFetch(recorded, (url) =>
        url.endsWith("/health")
          ? {
              ok: true,
              status: 200,
              statusText: "OK",
              body: JSON.stringify({ slot_save_path: "/x" }),
            }
          : { ok: true, status: 200, statusText: "OK", body: "{}" },
      ),
    });
  }

  it("save hits POST /slots/<resolved>/save and registers the name", async () => {
    const recorded: Recorded[] = [];
    const mgr = makeEnabledMgr(recorded);
    await mgr.detectCapability();
    const handle = await mgr.save(4, "pre-speculative-T1");
    expect(handle).not.toBeNull();
    const saveCall = recorded.find((r) => /\/slots\/\d+\/save/.test(r.url));
    expect(saveCall?.method).toBe("POST");
    expect(saveCall?.url).toMatch(/\/slots\/4\/save\?filename=/);
    expect(mgr.getNamedHandle("pre-speculative-T1")).toBe(handle);
    expect(mgr.registrySize()).toBe(1);
  });

  it("restore by name looks up the registry; restore by handle goes straight to REST", async () => {
    const recorded: Recorded[] = [];
    const mgr = makeEnabledMgr(recorded);
    await mgr.detectCapability();
    const handle = await mgr.save(4, "pre-speculative-T1");
    expect(handle).not.toBeNull();
    const ok1 = await mgr.restore(4, "pre-speculative-T1");
    expect(ok1).toBe(true);
    if (handle === null) {
      throw new Error("expected checkpoint handle");
    }
    const ok2 = await mgr.restore(4, handle);
    expect(ok2).toBe(true);
    const restoreCalls = recorded.filter((r) =>
      /\/slots\/\d+\/restore/.test(r.url),
    );
    expect(restoreCalls).toHaveLength(2);
    expect(restoreCalls[0].method).toBe("POST");
  });

  it("restore returns false for an unknown registry name", async () => {
    const recorded: Recorded[] = [];
    const mgr = makeEnabledMgr(recorded);
    await mgr.detectCapability();
    const ok = await mgr.restore(4, "no-such-name");
    expect(ok).toBe(false);
  });

  it("erase removes the registry entry", async () => {
    const recorded: Recorded[] = [];
    const mgr = makeEnabledMgr(recorded);
    await mgr.detectCapability();
    await mgr.save(4, "n1");
    expect(mgr.registrySize()).toBe(1);
    await mgr.erase(4, "n1");
    expect(mgr.registrySize()).toBe(0);
    expect(mgr.getNamedHandle("n1")).toBeNull();
  });
});

describe("GatedCheckpointManager — TTL eviction", () => {
  it("drops entries older than ttl on next access", async () => {
    const recorded: Recorded[] = [];
    let clock = 1_000_000;
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: true,
      namedHandleTtlMs: 5_000,
      now: () => clock,
      fetchImpl: makeFetch(recorded, (url) =>
        url.endsWith("/health")
          ? {
              ok: true,
              status: 200,
              statusText: "OK",
              body: JSON.stringify({ slot_save_path: "/x" }),
            }
          : { ok: true, status: 200, statusText: "OK", body: "{}" },
      ),
    });
    await mgr.detectCapability();
    await mgr.save(1, "stale");
    expect(mgr.registrySize()).toBe(1);
    clock += 5_001;
    expect(mgr.registrySize()).toBe(0);
    expect(mgr.getNamedHandle("stale")).toBeNull();
  });

  it("ttl=0 disables eviction", async () => {
    const recorded: Recorded[] = [];
    let clock = 1_000_000;
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: true,
      namedHandleTtlMs: 0,
      now: () => clock,
      fetchImpl: makeFetch(recorded, (url) =>
        url.endsWith("/health")
          ? {
              ok: true,
              status: 200,
              statusText: "OK",
              body: JSON.stringify({ slot_save_path: "/x" }),
            }
          : { ok: true, status: 200, statusText: "OK", body: "{}" },
      ),
    });
    await mgr.detectCapability();
    await mgr.save(1, "forever");
    clock += 10_000_000;
    expect(mgr.registrySize()).toBe(1);
  });
});

describe("GatedCheckpointManager — env-var precedence", () => {
  const orig = process.env[CTX_CHECKPOINTS_ENV_VAR];
  afterEach(() => {
    if (orig === undefined) delete process.env[CTX_CHECKPOINTS_ENV_VAR];
    else process.env[CTX_CHECKPOINTS_ENV_VAR] = orig;
  });

  it("explicit useCtxCheckpoints=false overrides env=1", () => {
    process.env[CTX_CHECKPOINTS_ENV_VAR] = "1";
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      useCtxCheckpoints: false,
    });
    expect(mgr.isFeatureFlagOn()).toBe(false);
  });

  it("when useCtxCheckpoints is omitted, env wins", () => {
    process.env[CTX_CHECKPOINTS_ENV_VAR] = "1";
    const mgr = new GatedCheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(mgr.isFeatureFlagOn()).toBe(true);
  });
});
