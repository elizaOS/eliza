import { describe, test, expect } from "bun:test";
import { resolveN8nApiKey } from "../../src/services/n8n-workflow-service";

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
    // The exact failure mode that broke the user's session: env has the
    // stale key, sidecar has the fresh one. (Same shape, opposite outcome
    // — we still want the working key.)
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
});
