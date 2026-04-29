import { afterAll, describe, expect, it } from "vitest";
import { Entry } from "@napi-rs/keyring";
import { KeyringBackend } from "../src/backends/keyring.js";

/**
 * Smoke test for the cross-platform KeyringBackend. Skipped if the host has
 * no usable Secret Service (typical of headless CI Linux runners without
 * libsecret / gnome-keyring). The probe runs at import time because vitest
 * evaluates `it.skipIf(...)` during test collection, before any `beforeAll`.
 */

const PROBE_SERVICE = "@elizaos/confidant-test";

const KEYRING_WORKS = (() => {
  try {
    const probe = new Entry(PROBE_SERVICE, "import-time-probe");
    probe.setPassword("probe-value");
    const ok = probe.getPassword() === "probe-value";
    probe.deleteCredential();
    return ok;
  } catch {
    return false;
  }
})();

afterAll(() => {
  for (const account of ["round-trip", "remove-target"]) {
    try {
      new Entry(PROBE_SERVICE, account).deleteCredential();
    } catch {
      /* ignore */
    }
  }
});

describe("KeyringBackend (cross-platform)", () => {
  it.skipIf(!KEYRING_WORKS)("stores and resolves a value", async () => {
    const backend = new KeyringBackend(PROBE_SERVICE);
    const ref = await backend.store("round-trip", "stored-value");
    expect(ref).toBe(`keyring://${PROBE_SERVICE}/round-trip`);
    expect(await backend.resolve(ref)).toBe("stored-value");
    await backend.remove(ref);
  });

  it.skipIf(!KEYRING_WORKS)(
    "remove() is idempotent on missing entries",
    async () => {
      const backend = new KeyringBackend(PROBE_SERVICE);
      await expect(
        backend.remove(`keyring://${PROBE_SERVICE}/never-existed`),
      ).resolves.toBeUndefined();
    },
  );

  it("rejects malformed keyring references", async () => {
    const backend = new KeyringBackend(PROBE_SERVICE);
    await expect(backend.resolve("op://wrong/scheme")).rejects.toThrow();
    await expect(backend.resolve("keyring://no-slash")).rejects.toThrow();
    await expect(backend.resolve("keyring://service/")).rejects.toThrow();
  });
});
