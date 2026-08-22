/** Exercises strict SSH parameter, host-key, and tunneled-request validation without opening a network connection. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

function fakeTunnelChild(options: { hangOnTerm?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kills: NodeJS.Signals[];
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal = "SIGTERM") => {
    child.kills.push(signal);
    if (signal === "SIGKILL" || !options.hangOnTerm) {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };
  return child;
}

async function createFakeTunnel(child: ChildProcess) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-ssh-test-"));
  await fs.writeFile(path.join(tempDir, "known-hosts"), "credential material");
  return {
    child,
    localPort: 31_337,
    signature: "test-signature",
    credentialRef: null,
    tempDir,
    startedAt: Date.now(),
  };
}

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
    expect(() =>
      sshRuntimeInternals.parseStartParams({
        runtimeId: "vps",
        credentialRef: "different-runtime",
        target: "eliza@host.example",
        sshPort: 22,
        remoteApiPort: 31337,
        expectedFingerprint: `SHA256:${"A".repeat(43)}`,
      }),
    ).toThrow("selected runtime");
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
        credentialRef: "different-runtime",
        path: "/api/health",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 5_000,
      }),
    ).toThrow("selected runtime");
    expect(
      normalizeSshRuntimeRequest({
        runtimeId: "vps",
        path: "/api/health",
        method: "GET",
        headers: { Accept: "application/json\r\nX-Evil: yes" },
        body: null,
        timeoutMs: 5_000,
      }).headers,
    ).toEqual({});
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

  it("awaits normal SSH exit before removing its private known-hosts directory", async () => {
    const child = fakeTunnelChild();
    const tunnel = await createFakeTunnel(child as unknown as ChildProcess);

    await sshRuntimeInternals.disposeTunnel(tunnel, 20);

    expect(child.kills).toEqual(["SIGTERM"]);
    await expect(fs.stat(tunnel.tempDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses SIGKILL for a hung SSH child and keeps repeated disposal idempotent", async () => {
    const child = fakeTunnelChild({ hangOnTerm: true });
    const tunnel = await createFakeTunnel(child as unknown as ChildProcess);

    const first = sshRuntimeInternals.disposeTunnel(tunnel, 10);
    const second = sshRuntimeInternals.disposeTunnel(tunnel, 10);
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(fs.stat(tunnel.tempDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
