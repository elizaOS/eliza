/**
 * `resolveAppliedCloudKeyFingerprint` (warm-pool claim re-credential, F0).
 *
 * The `POST /api/cloud/login/persist` route echoes a sha-256 prefix of the
 * cloud key the RUNNING runtime resolves after the swap, so the warm-claim
 * control plane can verify the process applied the pushed credential instead
 * of trusting transport acceptance (the F0 lineage is "control plane
 * believed, process didn't"). These tests pin:
 *   - resolution goes through `runtime.getSetting` FIRST (the inference
 *     precedence chain) so a stale key shadowing the swap is DETECTED — the
 *     fingerprint reflects the shadowing value, not the pushed one;
 *   - `process.env.ELIZAOS_CLOUD_API_KEY` is the fallback when the runtime is
 *     absent or offers no value;
 *   - the output is a 16-hex-char sha-256 prefix and never key material;
 *   - no key anywhere -> undefined (callers omit the field: unverified);
 *   - a throwing getSetting degrades to the env fallback, never a crash.
 * [sol-warmpool-keypush]
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolveAppliedCloudKeyFingerprint } from "../../src/routes/cloud-routes";

async function sha256Prefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

const priorEnvKey = process.env.ELIZAOS_CLOUD_API_KEY;

afterEach(() => {
  if (priorEnvKey === undefined) delete process.env.ELIZAOS_CLOUD_API_KEY;
  else process.env.ELIZAOS_CLOUD_API_KEY = priorEnvKey;
});

describe("resolveAppliedCloudKeyFingerprint", () => {
  test("fingerprints the runtime-resolved key as a 16-hex sha-256 prefix", async () => {
    const fp = await resolveAppliedCloudKeyFingerprint({
      runtime: { getSetting: () => "eliza_resolved_key" },
    });
    expect(fp).toBe(await sha256Prefix("eliza_resolved_key"));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain("eliza_");
  });

  test("getSetting precedence wins over process.env — a shadowing stale key is detected", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_pushed_key";
    const fp = await resolveAppliedCloudKeyFingerprint({
      runtime: { getSetting: () => "eliza_stale_shadowing_key" },
    });
    // The fingerprint reflects what the runtime RESOLVES (the shadowing
    // value), so the control plane's comparison against the pushed key fails.
    expect(fp).toBe(await sha256Prefix("eliza_stale_shadowing_key"));
    expect(fp).not.toBe(await sha256Prefix("eliza_pushed_key"));
  });

  test("falls back to process.env when the runtime is absent or empty-handed", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_env_key";
    expect(await resolveAppliedCloudKeyFingerprint({ runtime: null })).toBe(
      await sha256Prefix("eliza_env_key")
    );
    expect(
      await resolveAppliedCloudKeyFingerprint({
        runtime: { getSetting: () => undefined },
      })
    ).toBe(await sha256Prefix("eliza_env_key"));
  });

  test("returns undefined when no key resolves anywhere", async () => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    expect(await resolveAppliedCloudKeyFingerprint({ runtime: null })).toBeUndefined();
  });

  test("a throwing getSetting degrades to the env fallback", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_env_key";
    const fp = await resolveAppliedCloudKeyFingerprint({
      runtime: {
        getSetting: () => {
          throw new Error("runtime not ready");
        },
      },
    });
    expect(fp).toBe(await sha256Prefix("eliza_env_key"));
  });
});
