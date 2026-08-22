/** Exercises strict SSH parameter, host-key, and tunneled-request validation without opening a network connection. */
import { describe, expect, it } from "vitest";

import {
  normalizeSshRuntimeRequest,
  parseSshKeyscanOutput,
  sshRuntimeInternals,
} from "./ssh-runtime-rpc";

const ED25519_KEY = Buffer.from("deterministic-ed25519-host-key").toString(
  "base64",
);
const RSA_KEY = Buffer.from("deterministic-rsa-host-key").toString("base64");

describe("SSH runtime RPC", () => {
  it("derives OpenSSH SHA256 fingerprints and prefers ed25519", () => {
    const keys = parseSshKeyscanOutput(
      [
        `[host.example]:22 ssh-rsa ${RSA_KEY}`,
        `# comment`,
        `[host.example]:22 ssh-ed25519 ${ED25519_KEY}`,
      ].join("\n"),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({
      algorithm: "ssh-ed25519",
      fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/),
    });
  });

  it("rejects malformed keyscan rows and duplicate keys", () => {
    const keys = parseSshKeyscanOutput(
      [
        `[host.example]:22 ssh-ed25519 ${ED25519_KEY}`,
        `[host.example]:22 ssh-ed25519 ${ED25519_KEY}`,
        `[host.example]:22 ssh-dss ${ED25519_KEY}`,
        `[host.example]:22 ssh-rsa !!!`,
      ].join("\n"),
    );
    expect(keys).toHaveLength(1);
  });

  it("requires a user-qualified host, absolute identity path, and SHA256 confirmation", () => {
    expect(() =>
      sshRuntimeInternals.parseStartParams({
        runtimeId: "vps",
        target: "host.example",
        sshPort: 22,
        remoteApiPort: 31337,
        expectedFingerprint: `SHA256:${"A".repeat(43)}`,
      }),
    ).toThrow("user@host");
    expect(() =>
      sshRuntimeInternals.parseStartParams({
        runtimeId: "vps",
        target: "eliza@host.example",
        sshPort: 22,
        remoteApiPort: 31337,
        identityFile: "relative-key",
        expectedFingerprint: `SHA256:${"A".repeat(43)}`,
      }),
    ).toThrow("absolute local path");
    expect(() =>
      sshRuntimeInternals.parseStartParams({
        runtimeId: "vps",
        target: "eliza@host.example",
        sshPort: 22,
        remoteApiPort: 31337,
        expectedFingerprint: "MD5:unsafe",
      }),
    ).toThrow("Confirm a valid SHA256");
  });

  it("allowlists agent routes and strips authorization headers", () => {
    expect(
      normalizeSshRuntimeRequest({
        runtimeId: "vps",
        credentialRef: "vps",
        path: "/api/health?detail=1",
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer renderer-secret",
          "X-Forwarded-Host": "attacker.example",
        },
        body: null,
        timeoutMs: 5_000,
      }),
    ).toEqual({
      runtimeId: "vps",
      credentialRef: "vps",
      path: "/api/health?detail=1",
      method: "GET",
      headers: { accept: "application/json" },
      body: null,
      timeoutMs: 5_000,
    });
    expect(() =>
      normalizeSshRuntimeRequest({
        runtimeId: "vps",
        path: "/api/secrets",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 5_000,
      }),
    ).toThrow("not available through SSH");
    expect(() =>
      normalizeSshRuntimeRequest({
        runtimeId: "vps",
        path: "http://attacker.example/api/health",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 5_000,
      }),
    ).toThrow("not available through SSH");
  });
});
