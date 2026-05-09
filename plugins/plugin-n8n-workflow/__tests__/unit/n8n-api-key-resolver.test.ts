import { describe, test, expect } from "bun:test";
import {
  pickRotatedSidecarKey,
  resolveN8nApiKey,
} from "../../src/services/n8n-workflow-service";

const HOST = "http://127.0.0.1:5678";

function probeReturning(map: Record<string, boolean>) {
  return async (_host: string, key: string): Promise<boolean> => map[key] ?? false;
}

describe("resolveN8nApiKey", () => {
  test("returns null when neither sidecar nor env has a key", async () => {
    const result = await resolveN8nApiKey(HOST, null, {
      getSidecarKey: () => null,
      probe: probeReturning({}),
    });
    expect(result).toBeNull();
  });

  test("returns sidecar key when it is the only candidate", async () => {
    const result = await resolveN8nApiKey(HOST, null, {
      getSidecarKey: () => "sidecar-key",
      probe: probeReturning({ "sidecar-key": true }),
    });
    expect(result).toBe("sidecar-key");
  });

  test("returns env key when no sidecar is registered", async () => {
    const result = await resolveN8nApiKey(HOST, "env-key", {
      getSidecarKey: () => null,
      probe: probeReturning({ "env-key": true }),
    });
    expect(result).toBe("env-key");
  });

  test("prefers sidecar key over env when both are valid", async () => {
    const result = await resolveN8nApiKey(HOST, "env-key", {
      getSidecarKey: () => "sidecar-key",
      probe: probeReturning({ "sidecar-key": true, "env-key": true }),
    });
    expect(result).toBe("sidecar-key");
  });

  test("falls back to env key when sidecar key fails the probe", async () => {
    // Sidecar key is stale (e.g. provisioned against a now-reset n8n
    // instance) while the env key still passes. The resolver should detect
    // the sidecar probe failure and return the working env key.
    const result = await resolveN8nApiKey(HOST, "env-key", {
      getSidecarKey: () => "stale-sidecar-key",
      probe: probeReturning({ "env-key": true }),
    });
    expect(result).toBe("env-key");
  });

  test("falls back to sidecar key when env key fails the probe", async () => {
    // The other half of the user's failure mode: env was stale, sidecar
    // was fresh. After this PR: sidecar is preferred and validates clean.
    const result = await resolveN8nApiKey(HOST, "stale-env-key", {
      getSidecarKey: () => "sidecar-key",
      probe: probeReturning({ "sidecar-key": true }),
    });
    expect(result).toBe("sidecar-key");
  });

  test("returns sidecar key when both fail (canonical source for diagnosis)", async () => {
    const result = await resolveN8nApiKey(HOST, "env-key", {
      getSidecarKey: () => "sidecar-key",
      probe: probeReturning({}),
    });
    expect(result).toBe("sidecar-key");
  });

  test("returns env key when both fail and there is no sidecar", async () => {
    const result = await resolveN8nApiKey(HOST, "env-key", {
      getSidecarKey: () => null,
      probe: probeReturning({}),
    });
    expect(result).toBe("env-key");
  });

  test("does not call probe at all when only one candidate is present", async () => {
    let probed = 0;
    const probe = async (): Promise<boolean> => {
      probed += 1;
      return true;
    };
    await resolveN8nApiKey(HOST, null, {
      getSidecarKey: () => "sidecar-key",
      probe,
    });
    expect(probed).toBe(0);

    await resolveN8nApiKey(HOST, "env-key", {
      getSidecarKey: () => null,
      probe,
    });
    expect(probed).toBe(0);
  });

  test("when keys are identical, returns once without spurious diff log", async () => {
    // Both sources happen to hold the same string (e.g. user copy-pasted
    // the sidecar key into .env). Should still resolve cleanly.
    const result = await resolveN8nApiKey(HOST, "shared-key", {
      getSidecarKey: () => "shared-key",
      probe: probeReturning({ "shared-key": true }),
    });
    expect(result).toBe("shared-key");
  });

  test("probes both candidates concurrently when both are present", async () => {
    // Caps the worst-case startup wait at one probe interval rather than
    // two when n8n is slow or unreachable. Verifies both probes are
    // in-flight before either resolves.
    let inFlight = 0;
    let peakInFlight = 0;
    const probe = async (_host: string, _key: string): Promise<boolean> => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return false;
    };
    await resolveN8nApiKey(HOST, "env-key", {
      getSidecarKey: () => "sidecar-key",
      probe,
    });
    expect(peakInFlight).toBe(2);
  });
});

describe("pickRotatedSidecarKey", () => {
  test("returns null when sidecar has no key", () => {
    expect(pickRotatedSidecarKey(null, null)).toBeNull();
    expect(pickRotatedSidecarKey(null, "stale-x")).toBeNull();
  });

  test("refuses to rotate to the exact start-time stale key (the P1 fix)", () => {
    // n8n was reset; the sidecar's cached key is now revoked, the env key
    // is known to work. getClient must not flip the apiClient back to the
    // stale value on every request.
    expect(pickRotatedSidecarKey("stale-sidecar-key", "stale-sidecar-key")).toBeNull();
  });

  test("rotates when the sidecar value differs from the start-time stale key", () => {
    // Sidecar has reprovisioned a fresh key after the start-time probe
    // failure — pick it up so subsequent requests use the canonical
    // source again.
    expect(pickRotatedSidecarKey("fresh-sidecar-key", "stale-sidecar-key")).toBe(
      "fresh-sidecar-key",
    );
  });

  test("returns the sidecar value when there was no start-time stale key", () => {
    // Healthy path: start-time resolver chose the sidecar key (or there
    // was no sidecar at start). Live-refresh continues to follow the
    // sidecar.
    expect(pickRotatedSidecarKey("sidecar-key", null)).toBe("sidecar-key");
  });
});
