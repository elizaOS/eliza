/**
 * `CacheClient.delConfirmed` / `delPatternConfirmed` contract (#13417).
 *
 * The confirmation signal must distinguish:
 *   - no backend CONFIGURED  -> nothing could be caching a stale entry -> true;
 *   - backend configured but UNAVAILABLE (circuit breaker open / connecting)
 *     -> the stale entry may still live in the backend -> false (fail closed);
 *   - backend confirmed delete -> true; backend rejected delete -> false.
 *
 * Without the configured-vs-unavailable split, a Redis brownout would report a
 * revoked-credential invalidation as successful while the entry survives in
 * Redis until its TTL — a fail-open on the revocation path.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../utils/logger";
import { cache } from "./client";

// getRedisClient is private; access it for spying via a typed view.
type Internal = {
  getRedisClient: () => Promise<unknown>;
  isBackendConfigured: () => boolean;
};
const internal = cache as unknown as Internal;

describe("delConfirmed configured-vs-unavailable contract (#13417)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function stubNoClient() {
    // getRedisClient() returns null in BOTH "disabled" and "circuit open" cases;
    // the boolean must then be derived from whether a backend is configured.
    spies.push(spyOn(internal, "getRedisClient").mockResolvedValue(null));
  }

  test("no backend configured -> delConfirmed true (nothing to invalidate)", async () => {
    stubNoClient();
    spies.push(spyOn(internal, "isBackendConfigured").mockReturnValue(false));
    expect(await cache.delConfirmed("apikey:abc")).toBe(true);
  });

  test("backend configured but unavailable (circuit open) -> delConfirmed false (fail closed)", async () => {
    stubNoClient();
    spies.push(spyOn(internal, "isBackendConfigured").mockReturnValue(true));
    expect(await cache.delConfirmed("apikey:abc")).toBe(false);
  });

  test("backend rejection logs a bounded key class instead of the credential hash", async () => {
    const rawKey = "iac:auth:private-credential-hash:v1";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    spies.push(warn);
    spies.push(
      spyOn(internal, "getRedisClient").mockResolvedValue({
        del: async () => {
          throw new Error("delete unavailable");
        },
      }),
    );

    expect(
      await cache.delConfirmed(rawKey, {
        keyClass: "inference_auth",
      }),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith("[Cache] DEL failed", {
      keyClass: "inference_auth",
      error: "delete unavailable",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(rawKey);
  });

  test("no backend configured -> delPatternConfirmed true", async () => {
    stubNoClient();
    spies.push(spyOn(internal, "isBackendConfigured").mockReturnValue(false));
    expect(await cache.delPatternConfirmed("org:1:*")).toBe(true);
  });

  test("backend configured but unavailable -> delPatternConfirmed false (fail closed)", async () => {
    stubNoClient();
    spies.push(spyOn(internal, "isBackendConfigured").mockReturnValue(true));
    expect(await cache.delPatternConfirmed("org:1:*")).toBe(false);
  });

  test("a configured backend whose connect FAILED still reports configured (fail closed)", async () => {
    // Reproduce codex round-2 P1: the native-connect .catch downgrades `enabled`
    // to false, but `backendConfigured` must stay true so a stale entry in that
    // Redis is not treated as "nothing to invalidate".
    const priv = cache as unknown as { enabled: boolean | null; backendConfigured: boolean };
    const savedEnabled = priv.enabled;
    const savedConfigured = priv.backendConfigured;
    try {
      priv.enabled = false; // connect-failure downgrade
      priv.backendConfigured = true; // backend WAS selected
      stubNoClient();
      expect(await cache.delConfirmed("apikey:abc")).toBe(false);
    } finally {
      priv.enabled = savedEnabled;
      priv.backendConfigured = savedConfigured;
    }
  });
});
