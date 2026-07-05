/**
 * Host-key verification + Trust-On-First-Use tests.
 *
 * These exercise the REAL `verifyHostKey` logic on a real `DockerSSHClient`
 * (no real SSH server — the verifier is a pure function of the presented key,
 * the configured pin, and the `CONTAINERS_SSH_TOFU_PIN` flag). The three
 * behaviors under test are the security contract of the fix:
 *   1. a pin that MISMATCHES the presented key is always refused (possible MITM);
 *   2. a NULL pin is accepted on first use when TOFU is on, and the discovery
 *      callback receives the captured fingerprint;
 *   3. a NULL pin is refused when TOFU is off (strict fail-closed).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { DockerSSHClient, normalizeSshFingerprint } from "./docker-ssh";

/** A throwaway key blob the fake handshake "presents". */
const PRESENTED_KEY = Buffer.from("presented-host-key-material");
const PRESENTED_FP = normalizeSshFingerprint(
  crypto.createHash("sha256").update(PRESENTED_KEY).digest("base64"),
);

/** Inline SSH key so the constructor never touches the filesystem. */
const FAKE_SSH_KEY_B64 = Buffer.from("fake-private-key").toString("base64");

/** Typed view onto the private verifier + captured-fingerprint field. */
type VerifierHarness = {
  verifyHostKey(key: Buffer): boolean;
  getVerifiedHostKeyFingerprint(): string | undefined;
};

function makeClient(opts: {
  pin?: string;
  onHostKeyDiscovered?: (hostname: string, fingerprint: string) => Promise<void>;
}): DockerSSHClient & VerifierHarness {
  return new DockerSSHClient({
    hostname: "node.example.test",
    privateKey: Buffer.from("unused"),
    hostKeyFingerprint: opts.pin,
    onHostKeyDiscovered: opts.onHostKeyDiscovered,
  }) as DockerSSHClient & VerifierHarness;
}

const originalTofu = process.env.CONTAINERS_SSH_TOFU_PIN;
const originalLegacyTofu = process.env.ELIZA_CONTAINERS_SSH_TOFU_PIN;
const originalSshKey = process.env.CONTAINERS_SSH_KEY;

beforeEach(() => {
  process.env.CONTAINERS_SSH_KEY = FAKE_SSH_KEY_B64;
  delete process.env.CONTAINERS_SSH_TOFU_PIN;
  delete process.env.ELIZA_CONTAINERS_SSH_TOFU_PIN;
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("CONTAINERS_SSH_TOFU_PIN", originalTofu);
  restore("ELIZA_CONTAINERS_SSH_TOFU_PIN", originalLegacyTofu);
  restore("CONTAINERS_SSH_KEY", originalSshKey);
});

describe("verifyHostKey — pinned node", () => {
  test("accepts when the presented key matches the pin", () => {
    const client = makeClient({ pin: PRESENTED_FP });
    expect(client.verifyHostKey(PRESENTED_KEY)).toBe(true);
    expect(client.getVerifiedHostKeyFingerprint()).toBe(PRESENTED_FP);
  });

  test("refuses on mismatch even with TOFU on (possible MITM)", () => {
    process.env.CONTAINERS_SSH_TOFU_PIN = "true";
    const client = makeClient({ pin: "some-other-fingerprint-value" });
    expect(client.verifyHostKey(PRESENTED_KEY)).toBe(false);
  });
});

describe("verifyHostKey — unpinned node (NULL pin)", () => {
  test("accepts on first use and captures the fingerprint when TOFU is on (default)", () => {
    const client = makeClient({});
    expect(client.verifyHostKey(PRESENTED_KEY)).toBe(true);
    expect(client.getVerifiedHostKeyFingerprint()).toBe(PRESENTED_FP);
  });

  test("refuses when TOFU is explicitly disabled", () => {
    process.env.CONTAINERS_SSH_TOFU_PIN = "false";
    const client = makeClient({});
    expect(client.verifyHostKey(PRESENTED_KEY)).toBe(false);
    expect(client.getVerifiedHostKeyFingerprint()).toBeUndefined();
  });

  test("verifyHostKey records the fingerprint for later retrieval on TOFU accept", async () => {
    // The discovery callback fires from the post-`ready` handler after a live
    // ssh2 connect, which is not exercised here — the verifier itself only
    // captures the fingerprint. This asserts that capture (what the callback
    // later persists), not the callback invocation. The manager-side wiring that
    // actually invokes the callback is covered in the TOFU-persist manager test.
    const client = makeClient({
      onHostKeyDiscovered: async () => {
        // Never invoked by verifyHostKey alone; present only to prove the
        // capture path still runs when a callback is configured.
      },
    });

    // The verifier runs during the handshake and stashes the fingerprint...
    expect(client.verifyHostKey(PRESENTED_KEY)).toBe(true);
    // ...which is exactly what the post-ready callback would persist.
    const fp = client.getVerifiedHostKeyFingerprint();
    expect(fp).toBe(PRESENTED_FP);
  });
});
