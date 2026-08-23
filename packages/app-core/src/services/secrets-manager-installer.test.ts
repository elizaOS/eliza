/**
 * Unit tests for SecretsManagerInstaller: install job lifecycle, log/history
 * caps, terminal-job eviction, vendor sign-in/out, and the process singleton.
 * Drives the real class with an injected spawn fixture and createTestVault so
 * brew/npm/`op`/`bw` are never forked, while job state, vault writes, and CLI
 * argument construction run as written.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createManager,
  createTestVault,
  type InstallMethod,
  type SecretsManager,
  type TestVault,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetSecretsManagerInstallerForTesting,
  _setSecretsManagerInstallerForTesting,
  getSecretsManagerInstaller,
  type InstallJobEvent,
  type InstallJobSnapshot,
  SecretsManagerInstaller,
  type SpawnFn,
} from "./secrets-manager-installer";

const BREW_CASK: InstallMethod = {
  kind: "brew",
  package: "1password-cli",
  cask: true,
};
const BREW_FORMULA: InstallMethod = {
  kind: "brew",
  package: "bitwarden-cli",
  cask: false,
};
const NPM_METHOD: InstallMethod = {
  kind: "npm",
  package: "@bitwarden/cli",
};
const MANUAL_METHOD: InstallMethod = {
  kind: "manual",
  instructions: "Install from the vendor page.",
  url: "https://example.invalid/install",
};

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: {
    stdio: ["ignore" | "pipe", "pipe", "pipe"];
    shell: false;
    env?: NodeJS.ProcessEnv;
  };
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  stdinChunks: string[] = [];
  killed = false;
  lastKillSignal: NodeJS.Signals | undefined;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.stdinChunks.push(String(chunk));
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.lastKillSignal = signal;
    return true;
  }
}

function asChildProcess(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function finishChild(
  child: FakeChild,
  code: number | null,
  io: { stdout?: string; stderr?: string } = {},
): void {
  if (io.stdout !== undefined) child.stdout.write(io.stdout);
  if (io.stderr !== undefined) child.stderr.write(io.stderr);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code);
}

function waitForStatus(
  installer: SecretsManagerInstaller,
  jobId: string,
  status: InstallJobSnapshot["status"],
): Promise<InstallJobSnapshot> {
  return new Promise((resolve, reject) => {
    const current = installer.getJob(jobId);
    if (current?.status === status) {
      resolve(current);
      return;
    }
    try {
      const unsub = installer.subscribeJob(jobId, (event) => {
        if (event.type === "status" && event.status === status) {
          unsub();
          const snap = installer.getJob(jobId);
          if (snap) resolve(snap);
          else reject(new Error(`job vanished: ${jobId}`));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

describe("SecretsManagerInstaller", () => {
  const vaults: TestVault[] = [];
  const children: FakeChild[] = [];
  let calls: SpawnCall[] = [];
  let spawnQueue: FakeChild[] = [];
  let manager: SecretsManager;
  let installer: SecretsManagerInstaller;
  let autoEnqueue = true;

  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const queued = spawnQueue.shift();
    if (queued) return asChildProcess(queued);
    if (!autoEnqueue) {
      throw new Error(`unexpected spawn: ${command} ${args.join(" ")}`);
    }
    const child = new FakeChild();
    children.push(child);
    return asChildProcess(child);
  };

  function enqueue(): FakeChild {
    const child = new FakeChild();
    children.push(child);
    spawnQueue.push(child);
    return child;
  }

  beforeEach(async () => {
    calls = [];
    spawnQueue = [];
    autoEnqueue = true;
    const test = await createTestVault();
    vaults.push(test);
    manager = createManager({
      vault: test.vault,
      exec: async () => ({ stdout: "[]", stderr: "" }),
    });
    installer = new SecretsManagerInstaller({ manager, spawn });
    _resetSecretsManagerInstallerForTesting();
  });

  afterEach(async () => {
    vi.useRealTimers();
    _resetSecretsManagerInstallerForTesting();
    // Flush startInstall's setImmediate so a leftover spawn cannot leak
    // into the next test's `children` array.
    await nextTick();
    for (const child of children.splice(0)) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
    spawnQueue = [];
    await Promise.all(vaults.splice(0).map((test) => test.dispose()));
  });

  describe("startInstall", () => {
    it("rejects a manual method before spawning", () => {
      expect(() => installer.startInstall("1password", MANUAL_METHOD)).toThrow(
        TypeError,
      );
      expect(() => installer.startInstall("1password", MANUAL_METHOD)).toThrow(
        /Cannot automate install for "1password": method is manual\. Direct the user to https:\/\/example\.invalid\/install/,
      );
      expect(calls).toEqual([]);
    });

    it("rejects a non-manual method that has no argv", () => {
      expect(() =>
        installer.startInstall("bitwarden", {
          kind: "snap",
        } as unknown as InstallMethod),
      ).toThrow(
        /buildInstallCommand returned null for non-manual method \(snap\)/,
      );
      expect(calls).toEqual([]);
    });

    it("returns a pending snapshot with a UUID before the child starts", () => {
      const snap = installer.startInstall("1password", BREW_CASK);
      expect(snap.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(snap.backendId).toBe("1password");
      expect(snap.method).toEqual(BREW_CASK);
      expect(snap.status).toBe("pending");
      expect(snap.endedAt).toBeNull();
      expect(snap.exitCode).toBeNull();
      expect(snap.errorMessage).toBeNull();
      expect(snap.history).toEqual([]);
      expect(snap.startedAt).toBeGreaterThan(0);
      expect(calls).toEqual([]);
    });

    it("spawns brew --cask for a cask method and brew without --cask for a formula", async () => {
      const cask = installer.startInstall("1password", BREW_CASK);
      const formula = installer.startInstall("bitwarden", BREW_FORMULA);
      await nextTick();
      expect(calls[0]).toMatchObject({
        command: "brew",
        args: ["install", "--cask", "1password-cli"],
        options: { stdio: ["ignore", "pipe", "pipe"], shell: false },
      });
      expect(calls[1]).toMatchObject({
        command: "brew",
        args: ["install", "bitwarden-cli"],
        options: { stdio: ["ignore", "pipe", "pipe"], shell: false },
      });
      expect(installer.getJob(cask.id)?.status).toBe("running");
      expect(installer.getJob(formula.id)?.status).toBe("running");
    });

    it("spawns npm install -g for an npm method", async () => {
      installer.startInstall("bitwarden", NPM_METHOD);
      await nextTick();
      expect(calls[0]).toMatchObject({
        command: "npm",
        args: ["install", "-g", "@bitwarden/cli"],
      });
    });

    it("marks the job succeeded and copies history on a zero exit", async () => {
      const snap = installer.startInstall("bitwarden", NPM_METHOD);
      const pending = waitForStatus(installer, snap.id, "succeeded");
      await nextTick();
      finishChild(children[0] as FakeChild, 0, {
        stdout: "installed\n",
      });
      const done = await pending;
      expect(done.status).toBe("succeeded");
      expect(done.exitCode).toBe(0);
      expect(done.errorMessage).toBeNull();
      expect(done.endedAt).toBeGreaterThanOrEqual(done.startedAt);
      expect(done.history).toEqual(
        expect.arrayContaining([
          { type: "status", status: "running" },
          { type: "log", stream: "stdout", line: "installed" },
          { type: "done", exitCode: 0 },
          { type: "status", status: "succeeded" },
        ]),
      );
      const earlier = snap.history;
      expect(earlier).toEqual([]);
      expect(installer.getJob(snap.id)?.history).not.toBe(earlier);
    });

    it("marks the job failed when the child exits non-zero, including a null code", async () => {
      const nonzero = installer.startInstall("bitwarden", NPM_METHOD);
      const nullCode = installer.startInstall("bitwarden", NPM_METHOD);
      const failedA = waitForStatus(installer, nonzero.id, "failed");
      const failedB = waitForStatus(installer, nullCode.id, "failed");
      await nextTick();
      finishChild(children[0] as FakeChild, 7, { stderr: "boom\n" });
      finishChild(children[1] as FakeChild, null);
      const a = await failedA;
      const b = await failedB;
      expect(a.exitCode).toBe(7);
      expect(a.errorMessage).toBe("install exited with code 7");
      expect(a.history).toEqual(
        expect.arrayContaining([
          { type: "error", message: "install exited with code 7" },
          { type: "status", status: "failed" },
        ]),
      );
      expect(b.exitCode).toBe(1);
      expect(b.errorMessage).toBe("install exited with code 1");
    });

    it("fails the job on spawn error, including a non-Error value", async () => {
      const errJob = installer.startInstall("1password", BREW_CASK);
      const rawJob = installer.startInstall("1password", BREW_CASK);
      const failedA = waitForStatus(installer, errJob.id, "failed");
      const failedB = waitForStatus(installer, rawJob.id, "failed");
      await nextTick();
      (children[0] as FakeChild).emit("error", new Error("spawn brew ENOENT"));
      (children[1] as FakeChild).emit("error", 42);
      const a = await failedA;
      const b = await failedB;
      expect(a.exitCode).toBeNull();
      expect(a.errorMessage).toBe("spawn brew ENOENT");
      expect(a.history).toEqual(
        expect.arrayContaining([
          { type: "error", message: "spawn brew ENOENT" },
        ]),
      );
      expect(b.errorMessage).toBe("unknown spawn error: 42");
    });
  });

  describe("log streaming", () => {
    it("splits CRLF lines, flushes a trailing partial line, and tags stderr", async () => {
      const snap = installer.startInstall("bitwarden", NPM_METHOD);
      const pending = waitForStatus(installer, snap.id, "succeeded");
      await nextTick();
      const child = children[0] as FakeChild;
      child.stdout.write("hello\r\nworld");
      child.stderr.write("warn-line\n");
      child.stdout.end();
      child.stderr.end();
      // PassThrough emits `end` on a later tick than `end()` itself; wait so
      // the trailing partial line is flushed before the child `close`.
      await nextTick();
      child.emit("close", 0);
      const done = await pending;
      const logs = done.history.filter(
        (event): event is Extract<InstallJobEvent, { type: "log" }> =>
          event.type === "log",
      );
      expect(logs).toEqual([
        { type: "log", stream: "stdout", line: "hello" },
        { type: "log", stream: "stderr", line: "warn-line" },
        { type: "log", stream: "stdout", line: "world" },
      ]);
    });

    it("truncates a log line at 2000 characters", async () => {
      const snap = installer.startInstall("bitwarden", NPM_METHOD);
      const pending = waitForStatus(installer, snap.id, "succeeded");
      await nextTick();
      const long = "x".repeat(2001);
      finishChild(children[0] as FakeChild, 0, { stdout: `${long}\n` });
      const done = await pending;
      const log = done.history.find(
        (event): event is Extract<InstallJobEvent, { type: "log" }> =>
          event.type === "log" && event.stream === "stdout",
      );
      expect(log?.line).toHaveLength(2000);
      expect(log?.line).toBe("x".repeat(2000));
    });

    it("drops the oldest history once more than 500 events have been recorded", async () => {
      const snap = installer.startInstall("bitwarden", NPM_METHOD);
      const pending = waitForStatus(installer, snap.id, "succeeded");
      await nextTick();
      const lines = Array.from({ length: 520 }, (_, i) => `line-${i}`).join(
        "\n",
      );
      finishChild(children[0] as FakeChild, 0, { stdout: `${lines}\n` });
      const done = await pending;
      expect(done.history.length).toBeLessThanOrEqual(500);
      const logLines = done.history
        .filter(
          (event): event is Extract<InstallJobEvent, { type: "log" }> =>
            event.type === "log",
        )
        .map((event) => event.line);
      expect(logLines).not.toContain("line-0");
      expect(logLines).toContain("line-519");
    });

    it("still completes when stdout and stderr are absent", async () => {
      autoEnqueue = false;
      const child = new EventEmitter() as EventEmitter & {
        stdout: null;
        stderr: null;
        stdin: null;
        kill: () => boolean;
      };
      child.stdout = null;
      child.stderr = null;
      child.stdin = null;
      child.kill = () => true;
      spawnQueue.push(child as unknown as FakeChild);
      const spawnNull: SpawnFn = (command, args, options) => {
        calls.push({ command, args, options });
        const next = spawnQueue.shift();
        if (!next) throw new Error("missing null child");
        return next as unknown as ChildProcess;
      };
      const isolated = new SecretsManagerInstaller({
        manager,
        spawn: spawnNull,
      });
      const snap = isolated.startInstall("bitwarden", NPM_METHOD);
      const pending = waitForStatus(isolated, snap.id, "succeeded");
      await nextTick();
      child.emit("close", 0);
      const done = await pending;
      expect(done.status).toBe("succeeded");
      expect(done.history.filter((event) => event.type === "log")).toEqual([]);
    });
  });

  describe("subscribeJob and getJob", () => {
    it("returns null for a missing job and throws on subscribe", () => {
      expect(installer.getJob("missing-id")).toBeNull();
      expect(() =>
        installer.subscribeJob("missing-id", () => undefined),
      ).toThrow("unknown install job: missing-id");
    });

    it("replays history to a late subscriber and no-ops unsubscribe on a terminal job", async () => {
      const snap = installer.startInstall("bitwarden", NPM_METHOD);
      const pending = waitForStatus(installer, snap.id, "succeeded");
      await nextTick();
      finishChild(children[0] as FakeChild, 0, { stdout: "ok\n" });
      await pending;
      const replayed: InstallJobEvent[] = [];
      const unsub = installer.subscribeJob(snap.id, (event) => {
        replayed.push(event);
      });
      expect(replayed.some((event) => event.type === "done")).toBe(true);
      expect(unsub()).toBeUndefined();
    });

    it("forwards live events until unsubscribe", async () => {
      const snap = installer.startInstall("bitwarden", NPM_METHOD);
      const live: InstallJobEvent[] = [];
      const unsub = installer.subscribeJob(snap.id, (event) => {
        live.push(event);
      });
      await nextTick();
      const child = children[0] as FakeChild;
      child.stdout.write("one\n");
      unsub();
      child.stdout.write("two\n");
      finishChild(child, 0);
      await waitForStatus(installer, snap.id, "succeeded");
      expect(live).toEqual(
        expect.arrayContaining([
          { type: "log", stream: "stdout", line: "one" },
        ]),
      );
      expect(live).not.toEqual(
        expect.arrayContaining([
          { type: "log", stream: "stdout", line: "two" },
        ]),
      );
    });
  });

  describe("job retention", () => {
    it("evicts the oldest terminal job once more than 100 are retained", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push(installer.startInstall("bitwarden", NPM_METHOD).id);
      }
      await nextTick();
      expect(children).toHaveLength(100);
      const finished = ids.map((id) =>
        waitForStatus(installer, id, "succeeded"),
      );
      for (const child of children) finishChild(child, 0);
      await Promise.all(finished);
      expect(installer.getJob(ids[0] as string)?.status).toBe("succeeded");

      const overflow = installer.startInstall("bitwarden", NPM_METHOD);
      expect(installer.getJob(ids[0] as string)).toBeNull();
      expect(installer.getJob(ids[1] as string)?.status).toBe("succeeded");
      expect(installer.getJob(overflow.id)?.status).toBe("pending");
      await nextTick();
      finishChild(children.at(-1) as FakeChild, 0);
      await waitForStatus(installer, overflow.id, "succeeded");
    });

    it("never evicts a still-running job, even when terminal jobs overflow the cap", async () => {
      const running = installer.startInstall("bitwarden", NPM_METHOD);
      await nextTick();
      const runningChild = children.at(-1) as FakeChild;
      expect(installer.getJob(running.id)?.status).toBe("running");
      const terminal: string[] = [];
      for (let i = 0; i < 100; i++) {
        terminal.push(installer.startInstall("bitwarden", NPM_METHOD).id);
      }
      await nextTick();
      const finished = terminal.map((id) =>
        waitForStatus(installer, id, "failed"),
      );
      for (const child of children) {
        if (child !== runningChild) finishChild(child, 1);
      }
      await Promise.all(finished);
      installer.startInstall("bitwarden", NPM_METHOD);
      expect(installer.getJob(running.id)?.status).toBe("running");
      expect(installer.getJob(terminal[0] as string)).toBeNull();
      runningChild.emit("close", 0);
    });
  });

  describe("getInstallMethods", () => {
    it("always includes the Proton Pass manual method", async () => {
      const methods = await installer.getInstallMethods("protonpass");
      expect(methods.some((method) => method.kind === "manual")).toBe(true);
      const manual = methods.find((method) => method.kind === "manual");
      expect(manual).toMatchObject({
        kind: "manual",
        url: "https://protonpass.github.io/pass-cli/",
      });
    });
  });

  describe("signIn 1Password", () => {
    it("requires email, secretKey, and masterPassword before spawning", async () => {
      autoEnqueue = false;
      await expect(
        installer.signIn({
          backendId: "1password",
          masterPassword: "pw",
          secretKey: "A".repeat(34),
        }),
      ).rejects.toThrow("1Password sign-in requires `email`");
      await expect(
        installer.signIn({
          backendId: "1password",
          email: "owner@example.test",
          masterPassword: "pw",
        }),
      ).rejects.toThrow(
        "1Password sign-in requires `secretKey` (the 34-char Secret Key)",
      );
      await expect(
        installer.signIn({
          backendId: "1password",
          email: "owner@example.test",
          secretKey: "A".repeat(34),
          masterPassword: "",
        }),
      ).rejects.toThrow("1Password sign-in requires `masterPassword`");
      expect(calls).toEqual([]);
    });

    it("stores the session from `op account add` and pipes the password on stdin", async () => {
      autoEnqueue = false;
      const add = enqueue();
      const pending = installer.signIn({
        backendId: "1password",
        email: "owner@example.test",
        secretKey: "A".repeat(34),
        masterPassword: "master-pw",
      });
      await nextTick();
      expect(calls[0]).toMatchObject({
        command: "op",
        args: [
          "account",
          "add",
          "--address",
          "my.1password.com",
          "--email",
          "owner@example.test",
          "--secret-key",
          "A".repeat(34),
          "--signin",
          "--raw",
        ],
        options: { stdio: ["pipe", "pipe", "pipe"], shell: false },
      });
      expect(add.stdinChunks.join("")).toBe("master-pw");
      finishChild(add, 0, { stdout: "  op-session-token  \n" });
      await expect(pending).resolves.toEqual({
        backendId: "1password",
        sessionStored: true,
        message: "Signed in as owner@example.test at my.1password.com",
      });
      expect(await installer.getSession("1password")).toBe("op-session-token");
      expect(calls).toHaveLength(1);
    });

    it("defaults a blank sign-in address and still stores a token when account add exits non-zero", async () => {
      autoEnqueue = false;
      const add = enqueue();
      const pending = installer.signIn({
        backendId: "1password",
        email: "owner@example.test",
        secretKey: "sk",
        masterPassword: "pw",
        signInAddress: "   ",
      });
      await nextTick();
      expect(calls[0]?.args).toContain("my.1password.com");
      finishChild(add, 2, { stdout: "token-despite-exit\n" });
      await expect(pending).resolves.toMatchObject({
        sessionStored: true,
        message: "Signed in as owner@example.test at my.1password.com",
      });
      expect(await installer.getSession("1password")).toBe(
        "token-despite-exit",
      );
    });

    it("falls back to `op signin --raw` when account add emits no token", async () => {
      autoEnqueue = false;
      const add = enqueue();
      const signin = enqueue();
      const pending = installer.signIn({
        backendId: "1password",
        email: "owner@example.test",
        secretKey: "sk",
        masterPassword: "pw",
        signInAddress: "team.1password.com",
      });
      await nextTick();
      finishChild(add, 0, { stdout: "\n" });
      await nextTick();
      expect(calls[1]).toMatchObject({
        command: "op",
        args: ["signin", "--account", "team.1password.com", "--raw"],
      });
      finishChild(signin, 0, { stdout: "fallback-token\n" });
      await expect(pending).resolves.toMatchObject({
        message: "Signed in as owner@example.test at team.1password.com",
      });
      expect(await installer.getSession("1password")).toBe("fallback-token");
    });

    it("surfaces a truncated `op signin` failure", async () => {
      autoEnqueue = false;
      const add = enqueue();
      const signin = enqueue();
      const pending = installer.signIn({
        backendId: "1password",
        email: "owner@example.test",
        secretKey: "sk",
        masterPassword: "pw",
      });
      await nextTick();
      finishChild(add, 0, { stdout: "" });
      await nextTick();
      const noisy = `fail\n${"e".repeat(900)}`;
      finishChild(signin, 9, { stderr: noisy });
      await expect(pending).rejects.toThrow(/op signin failed \(exit 9\):/);
      try {
        await pending;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message.endsWith("…")).toBe(true);
        expect(message.length).toBe(801);
        expect(message).not.toMatch(/\n/);
      }
    });
  });

  describe("signIn Bitwarden", () => {
    it("requires client id, client secret, and masterPassword", async () => {
      autoEnqueue = false;
      await expect(
        installer.signIn({
          backendId: "bitwarden",
          masterPassword: "pw",
          bitwardenClientSecret: "secret",
        }),
      ).rejects.toThrow(
        "Bitwarden sign-in requires `bitwardenClientId` (BW_CLIENTID)",
      );
      await expect(
        installer.signIn({
          backendId: "bitwarden",
          masterPassword: "pw",
          bitwardenClientId: "id",
        }),
      ).rejects.toThrow(
        "Bitwarden sign-in requires `bitwardenClientSecret` (BW_CLIENTSECRET)",
      );
      await expect(
        installer.signIn({
          backendId: "bitwarden",
          masterPassword: "",
          bitwardenClientId: "id",
          bitwardenClientSecret: "secret",
        }),
      ).rejects.toThrow("Bitwarden sign-in requires `masterPassword`");
      expect(calls).toEqual([]);
    });

    it("logs in via API key, unlocks with BW_PASSWORD, and stores the session", async () => {
      autoEnqueue = false;
      const login = enqueue();
      const unlock = enqueue();
      const pending = installer.signIn({
        backendId: "bitwarden",
        masterPassword: "vault-pw",
        bitwardenClientId: "client-id",
        bitwardenClientSecret: "client-secret",
      });
      await nextTick();
      expect(calls[0]).toMatchObject({
        command: "bw",
        args: ["login", "--apikey"],
        options: { stdio: ["ignore", "pipe", "pipe"], shell: false },
      });
      expect(calls[0]?.options.env?.BW_CLIENTID).toBe("client-id");
      expect(calls[0]?.options.env?.BW_CLIENTSECRET).toBe("client-secret");
      finishChild(login, 0);
      await nextTick();
      expect(calls[1]).toMatchObject({
        command: "bw",
        args: ["unlock", "--raw", "--passwordenv", "BW_PASSWORD"],
      });
      expect(calls[1]?.options.env?.BW_PASSWORD).toBe("vault-pw");
      finishChild(unlock, 0, { stdout: "bw-session\n" });
      await expect(pending).resolves.toEqual({
        backendId: "bitwarden",
        sessionStored: true,
        message: "Signed in via API key; vault unlocked",
      });
      expect(await installer.getSession("bitwarden")).toBe("bw-session");
    });

    it("treats 'already logged in' as success and still unlocks", async () => {
      autoEnqueue = false;
      const login = enqueue();
      const unlock = enqueue();
      const pending = installer.signIn({
        backendId: "bitwarden",
        masterPassword: "vault-pw",
        bitwardenClientId: "id",
        bitwardenClientSecret: "secret",
      });
      await nextTick();
      finishChild(login, 1, {
        stderr: "You are already logged in as user@example.test\n",
      });
      await nextTick();
      finishChild(unlock, 0, { stdout: "existing-session" });
      await expect(pending).resolves.toEqual({
        backendId: "bitwarden",
        sessionStored: true,
        message: "Already logged in; vault unlocked",
      });
    });

    it("throws when login fails for a reason other than already logged in", async () => {
      autoEnqueue = false;
      const login = enqueue();
      const pending = installer.signIn({
        backendId: "bitwarden",
        masterPassword: "vault-pw",
        bitwardenClientId: "id",
        bitwardenClientSecret: "secret",
      });
      await nextTick();
      finishChild(login, 1, { stdout: "invalid client_secret" });
      await expect(pending).rejects.toThrow(
        "bw login failed (exit 1): invalid client_secret",
      );
    });

    it("throws when unlock exits non-zero or returns an empty token", async () => {
      autoEnqueue = false;
      const login = enqueue();
      const unlock = enqueue();
      const pending = installer.signIn({
        backendId: "bitwarden",
        masterPassword: "vault-pw",
        bitwardenClientId: "id",
        bitwardenClientSecret: "secret",
      });
      await nextTick();
      finishChild(login, 0);
      await nextTick();
      finishChild(unlock, 0, { stdout: "   \n" });
      await expect(pending).rejects.toThrow(/bw unlock failed \(exit 0\):/);
    });
  });

  describe("unsupported backends, session, and timeout", () => {
    it("rejects Proton Pass sign-in", async () => {
      await expect(
        installer.signIn({
          backendId: "protonpass",
          masterPassword: "pw",
        }),
      ).rejects.toThrow(
        'Sign-in for "protonpass" is unsupported because the vendor CLI contract is unstable.',
      );
    });

    it("getSession returns null when unsigned, and signOut is a no-op then a removal", async () => {
      expect(await installer.getSession("bitwarden")).toBeNull();
      await expect(installer.signOut("bitwarden")).resolves.toBeUndefined();

      autoEnqueue = false;
      const login = enqueue();
      const unlock = enqueue();
      const pending = installer.signIn({
        backendId: "bitwarden",
        masterPassword: "vault-pw",
        bitwardenClientId: "id",
        bitwardenClientSecret: "secret",
      });
      await nextTick();
      finishChild(login, 0);
      await nextTick();
      finishChild(unlock, 0, { stdout: "sess" });
      await pending;
      expect(await installer.getSession("bitwarden")).toBe("sess");
      await installer.signOut("bitwarden");
      expect(await installer.getSession("bitwarden")).toBeNull();
    });

    it("kills a hung sign-in child after 60s", async () => {
      autoEnqueue = false;
      vi.useFakeTimers();
      const login = enqueue();
      const pending = installer.signIn({
        backendId: "bitwarden",
        masterPassword: "vault-pw",
        bitwardenClientId: "id",
        bitwardenClientSecret: "secret",
      });
      const expectation = expect(pending).rejects.toThrow(
        "bw timed out after 60000ms",
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await expectation;
      expect(login.killed).toBe(true);
      expect(login.lastKillSignal).toBe("SIGKILL");
    });
  });

  describe("singleton hooks", () => {
    it("memoizes getSecretsManagerInstaller until reset or replace", () => {
      const first = getSecretsManagerInstaller(manager);
      expect(getSecretsManagerInstaller(manager)).toBe(first);
      const replacement = new SecretsManagerInstaller({ manager, spawn });
      _setSecretsManagerInstallerForTesting(replacement);
      expect(getSecretsManagerInstaller()).toBe(replacement);
      _resetSecretsManagerInstallerForTesting();
      const afterReset = getSecretsManagerInstaller(manager);
      expect(afterReset).not.toBe(first);
      expect(afterReset).not.toBe(replacement);
    });
  });
});
