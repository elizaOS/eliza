/**
 * Unit tests for the CloudAuth background API-key re-validation state machine
 * (`decideRevalidation`). This is the self-heal that fixes an agent going
 * 401-blind after its injected key is revoked: it retries transient
 * cloud-unreachability (so a boot-time outage doesn't leave the key unvalidated
 * forever), confirms a revoked key with a single loud actionable error
 * (debounced so a transient 5xx doesn't false-alarm), and steady-re-checks so a
 * post-boot revocation is caught and a later re-authorization self-heals.
 */
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiKeyProbe,
  CloudAuthService,
  decideRevalidation,
  type RevalidationConfig,
  type RevalidationState,
} from "../src/services/cloud-auth";

const CFG: RevalidationConfig = {
  retryMs: 1_000,
  steadyMs: 60_000,
  invalidThreshold: 2,
};
const UNKNOWN: RevalidationState = { keyState: "unknown", consecutiveInvalid: 0 };

describe("decideRevalidation", () => {
  it("valid probe → confirms the key, logs once, steady re-check", () => {
    const d = decideRevalidation(UNKNOWN, "valid", CFG);
    expect(d.state).toEqual({ keyState: "valid", consecutiveInvalid: 0 });
    expect(d.delayMs).toBe(CFG.steadyMs);
    expect(d.log).toEqual({ level: "info", message: expect.stringContaining("validated") });
  });

  it("valid again (already valid) → no duplicate log", () => {
    const d = decideRevalidation({ keyState: "valid", consecutiveInvalid: 0 }, "valid", CFG);
    expect(d.state.keyState).toBe("valid");
    expect(d.log).toBeNull();
    expect(d.delayMs).toBe(CFG.steadyMs);
  });

  it("unreachable at boot → keeps state unresolved + retries (the 37911a1e fix)", () => {
    const d = decideRevalidation(UNKNOWN, "unreachable", CFG);
    expect(d.state).toEqual(UNKNOWN); // still unknown — will keep probing
    expect(d.delayMs).toBe(CFG.retryMs);
    expect(d.log).toBeNull();
  });

  it("single invalid probe → NOT confirmed yet (debounce), re-probe soon, no error", () => {
    const d = decideRevalidation(UNKNOWN, "invalid", CFG);
    expect(d.state).toEqual({ keyState: "unknown", consecutiveInvalid: 1 });
    expect(d.delayMs).toBe(CFG.retryMs);
    expect(d.log).toBeNull();
  });

  it("second consecutive invalid → CONFIRMS revoked, logs a single error, steady re-check", () => {
    const d = decideRevalidation({ keyState: "unknown", consecutiveInvalid: 1 }, "invalid", CFG);
    expect(d.state).toEqual({ keyState: "invalid", consecutiveInvalid: 2 });
    expect(d.delayMs).toBe(CFG.steadyMs);
    expect(d.log?.level).toBe("error");
    expect(d.log?.message).toMatch(/REVOKED\/INVALID/);
  });

  it("invalid again (already invalid) → no duplicate error log", () => {
    const d = decideRevalidation({ keyState: "invalid", consecutiveInvalid: 2 }, "invalid", CFG);
    expect(d.state.keyState).toBe("invalid");
    expect(d.log).toBeNull();
  });

  it("a network blip between two rejections does NOT reset the confirmation count", () => {
    // invalid(1) → unreachable (blip) → invalid → should confirm on the 2nd real rejection
    let s = decideRevalidation(UNKNOWN, "invalid", CFG).state; // count=1
    s = decideRevalidation(s, "unreachable", CFG).state; // count preserved
    expect(s.consecutiveInvalid).toBe(1);
    const d = decideRevalidation(s, "invalid", CFG); // count=2 → confirmed
    expect(d.state.keyState).toBe("invalid");
    expect(d.log?.level).toBe("error");
  });

  it("self-heals: confirmed-invalid → valid re-authorization clears the state + logs recovery", () => {
    const d = decideRevalidation({ keyState: "invalid", consecutiveInvalid: 2 }, "valid", CFG);
    expect(d.state).toEqual({ keyState: "valid", consecutiveInvalid: 0 });
    expect(d.log).toEqual({ level: "info", message: expect.stringContaining("validated") });
    expect(d.delayMs).toBe(CFG.steadyMs);
  });

  it("uses the default config when none is passed", () => {
    const d = decideRevalidation(UNKNOWN, "valid");
    expect(d.state.keyState).toBe("valid");
    expect(d.delayMs).toBe(30 * 60_000);
  });
});

/**
 * I/O-layer classification tests for the private `probeApiKey`. These exercise
 * the REAL `CloudApiClient` against a local HTTP server so the genuine
 * `CloudApiError` (non-2xx) / raw-fetch-error (timeout, connection refused)
 * paths are hit — the layer the unit tests above intentionally don't cover.
 *
 * The defect being guarded: a catch-all `return "invalid"` turned every non-auth
 * failure (5xx / 429 / timeout / outage) into a false "key REVOKED" alarm. Only
 * a reachable-but-rejected auth response (401/403) is `invalid`; everything else
 * is `unreachable`.
 */
describe("CloudAuthService.probeApiKey classification (I/O)", () => {
  let server: http.Server;
  let baseUrl: string;
  /** Per-test response control. `hang: true` never responds → forces a timeout. */
  let next: { status: number; hang: boolean };

  function probe(): Promise<ApiKeyProbe> {
    const service = new CloudAuthService();
    service.getClient().setBaseUrl(baseUrl);
    // probeApiKey is private; reach it through a typed cast — we're testing the
    // real method, not re-implementing it.
    return (service as unknown as { probeApiKey(key: string): Promise<ApiKeyProbe> }).probeApiKey(
      "test-key"
    );
  }

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      if (next.hang) {
        return; // never respond → client AbortSignal.timeout fires
      }
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: `HTTP ${next.status}` }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          throw new Error("expected an AddressInfo from server.address()");
        }
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("200 OK → valid", async () => {
    next = { status: 200, hang: false };
    expect(await probe()).toBe("valid");
  });

  it("401 (cloud reachable, key rejected) → invalid", async () => {
    next = { status: 401, hang: false };
    expect(await probe()).toBe("invalid");
  });

  it("403 (cloud reachable, key forbidden) → invalid", async () => {
    next = { status: 403, hang: false };
    expect(await probe()).toBe("invalid");
  });

  it("500 (server error, NOT an auth signal) → unreachable, NOT invalid", async () => {
    next = { status: 500, hang: false };
    const result = await probe();
    expect(result).toBe("unreachable");
    expect(result).not.toBe("invalid");
  });

  it("429 (rate limited) → unreachable, NOT invalid", async () => {
    next = { status: 429, hang: false };
    const result = await probe();
    expect(result).toBe("unreachable");
    expect(result).not.toBe("invalid");
  });

  it("timeout / AbortError (server never responds) → unreachable, NOT invalid", async () => {
    next = { status: 0, hang: true };
    const result = await probe();
    expect(result).toBe("unreachable");
    expect(result).not.toBe("invalid");
  });

  it("connection refused (no server) → unreachable, NOT invalid", async () => {
    const service = new CloudAuthService();
    // Reserved-by-RFC port that nothing listens on → ECONNREFUSED (raw fetch error).
    service.getClient().setBaseUrl("http://127.0.0.1:1");
    const result = await (
      service as unknown as { probeApiKey(key: string): Promise<ApiKeyProbe> }
    ).probeApiKey("test-key");
    expect(result).toBe("unreachable");
    expect(result).not.toBe("invalid");
  });
});
