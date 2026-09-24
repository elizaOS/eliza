/** Exercises strict SSH parameter, host-key, and tunneled-request validation without opening a network connection. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SshRuntimeConnectionIntent } from "./ssh-runtime-intent-store";
import {
  desktopGetSshRuntimeStatus,
  desktopRehydrateSshRuntimes,
  normalizeSshRuntimeRequest,
  parseSshKeyscanOutput,
  sshRuntimeInternals,
} from "./ssh-runtime-rpc";

const ED25519_KEY = Buffer.from("deterministic-ed25519-host-key").toString(
  "base64",
);
const RSA_KEY = Buffer.from("deterministic-rsa-host-key").toString("base64");
const PINNED_FINGERPRINT = `SHA256:${"A".repeat(43)}`;

const RESTART_INTENT: SshRuntimeConnectionIntent = {
  runtimeId: "vps",
  target: "eliza@host.example",
  sshPort: 22,
  remoteApiPort: 31337,
  expectedFingerprint: PINNED_FINGERPRINT,
  identityFile: "/home/eliza/.ssh/id_ed25519",
  credentialRef: "vps",
};

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
        credentialRef: "vps",
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
        credentialRef: "vps",
        expectedFingerprint: `SHA256:${"A".repeat(43)}`,
      }),
    ).toThrow("absolute local path");
    expect(() =>
      sshRuntimeInternals.parseStartParams({
        runtimeId: "vps",
        target: "eliza@host.example",
        sshPort: 22,
        remoteApiPort: 31337,
        credentialRef: "vps",
        expectedFingerprint: "MD5:unsafe",
      }),
    ).toThrow("Confirm a valid SHA256");
    expect(() =>
      sshRuntimeInternals.parseStartParams({
        runtimeId: "vps",
        target: "eliza@host.example",
        sshPort: 22,
        remoteApiPort: 31337,
        credentialRef: "other-runtime",
        expectedFingerprint: `SHA256:${"A".repeat(43)}`,
      }),
    ).toThrow("must match the runtime id");
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

  it("removes the private known-hosts directory when process creation throws", async () => {
    let temporaryDirectory = "";

    await expect(
      sshRuntimeInternals.createSshTunnelChild(
        `[host.example]:22 ssh-ed25519 ${ED25519_KEY}`,
        (knownHostsPath) => {
          temporaryDirectory = path.dirname(knownHostsPath);
          throw new Error("spawn rejected arguments");
        },
      ),
    ).rejects.toThrow("spawn rejected arguments");

    expect(temporaryDirectory).not.toBe("");
    await expect(fs.stat(temporaryDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("observes spontaneous-exit cleanup failure without an unhandled rejection", async () => {
    const child = fakeTunnelChild();
    const tunnel = await createFakeTunnel(child as unknown as ChildProcess);
    const recordCleanupFailure = vi.fn();

    sshRuntimeInternals.observeTunnelExit("vps", tunnel, {
      dispose: async () => {
        throw new Error("temporary directory is busy");
      },
      recordCleanupFailure,
    });
    child.exitCode = 255;
    child.emit("exit", 255, null);

    await vi.waitFor(() => {
      expect(recordCleanupFailure).toHaveBeenCalledWith("vps");
    });
    await fs.rm(tunnel.tempDir, { force: true, recursive: true });
  });

  it("rehydrates restart intent only after secure pin and identity validation", async () => {
    const starts: unknown[] = [];
    await sshRuntimeInternals.rehydrateSshRuntimeIntent(RESTART_INTENT, {
      readCredential: async () => ({
        accessToken: "stored-outside-intent",
        sshHostFingerprint: PINNED_FINGERPRINT,
      }),
      statIdentityFile: async () => ({ isFile: () => true }),
      start: async (input) => {
        starts.push(input);
        return {
          apiBase: "http://127.0.0.1:30001",
          localPort: 30001,
          fingerprint: input.expectedFingerprint,
        };
      },
    });

    expect(starts).toEqual([
      expect.objectContaining({
        runtimeId: "vps",
        target: "eliza@host.example",
        expectedFingerprint: PINNED_FINGERPRINT,
      }),
    ]);
  });

  it("keeps restart intent stopped when the secure pin or identity is missing", async () => {
    const start = async () => ({
      apiBase: "http://127.0.0.1:30001",
      localPort: 30001,
      fingerprint: PINNED_FINGERPRINT,
    });
    await expect(
      sshRuntimeInternals.rehydrateSshRuntimeIntent(RESTART_INTENT, {
        readCredential: async () => ({
          accessToken: null,
          sshHostFingerprint: null,
        }),
        statIdentityFile: async () => ({ isFile: () => true }),
        start,
      }),
    ).rejects.toThrow("missing from secure storage");
    await expect(
      sshRuntimeInternals.rehydrateSshRuntimeIntent(RESTART_INTENT, {
        readCredential: async () => ({
          accessToken: null,
          sshHostFingerprint: PINNED_FINGERPRINT,
        }),
        statIdentityFile: async () => ({ isFile: () => false }),
        start,
      }),
    ).rejects.toThrow("identity file is unavailable");
  });

  it("propagates changed-key rejection and never falls back to a new host key", async () => {
    await expect(
      sshRuntimeInternals.rehydrateSshRuntimeIntent(RESTART_INTENT, {
        readCredential: async () => ({
          accessToken: null,
          sshHostFingerprint: PINNED_FINGERPRINT,
        }),
        statIdentityFile: async () => ({ isFile: () => true }),
        start: async () => {
          throw new Error(
            "SSH host key changed or the confirmed fingerprint is no longer offered. Connection was blocked.",
          );
        },
      }),
    ).rejects.toThrow("host key changed");
  });

  it("reports restored and blocked restart intents through the public boot seam", async () => {
    const restored = new Set<string>();
    const errors = new Map([
      [
        "blocked-vps",
        "The trusted SSH host fingerprint no longer matches this runtime.",
      ],
    ]);
    const intents = [
      {
        ...RESTART_INTENT,
        runtimeId: "restored-vps",
        credentialRef: "restored-vps",
      },
      {
        ...RESTART_INTENT,
        runtimeId: "blocked-vps",
        credentialRef: "blocked-vps",
      },
    ];

    await expect(
      desktopRehydrateSshRuntimes({
        listIntents: async () => intents,
        ensure: async (runtimeId) => {
          if (runtimeId === "restored-vps") restored.add(runtimeId);
          return restored.has(runtimeId);
        },
        isRunning: (runtimeId) => restored.has(runtimeId),
        getLastError: (runtimeId) => errors.get(runtimeId) ?? null,
      }),
    ).resolves.toEqual({
      restored: ["restored-vps"],
      blocked: [
        {
          runtimeId: "blocked-vps",
          error:
            "The trusted SSH host fingerprint no longer matches this runtime.",
        },
      ],
    });
  });

  it("returns the public blocked reason after an exited SSH tunnel cannot rehydrate", async () => {
    const exitedChild = fakeTunnelChild();
    exitedChild.exitCode = 255;
    const exitedTunnel = await createFakeTunnel(
      exitedChild as unknown as ChildProcess,
    );
    let tunnel: typeof exitedTunnel | undefined = exitedTunnel;
    const ensure = vi.fn(async () => false);
    const deleteTunnel = vi.fn(() => {
      tunnel = undefined;
    });

    await expect(
      desktopGetSshRuntimeStatus(
        { runtimeId: "vps" },
        {
          getTunnel: () => tunnel,
          deleteTunnel,
          ensure,
          getLastError: () =>
            "The SSH identity file is unavailable. Restore it and reconnect manually.",
        },
      ),
    ).resolves.toEqual({
      running: false,
      localPort: null,
      startedAt: null,
      reconnectState: "blocked",
      lastError:
        "The SSH identity file is unavailable. Restore it and reconnect manually.",
    });
    expect(deleteTunnel).toHaveBeenCalledWith("vps");
    expect(ensure).toHaveBeenCalledWith("vps");
    await fs.rm(exitedTunnel.tempDir, { force: true, recursive: true });
  });
});
