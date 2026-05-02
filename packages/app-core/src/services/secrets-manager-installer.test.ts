import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  createManager,
  createVault,
  generateMasterKey,
  inMemoryMasterKey,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SecretsManagerInstaller,
  type SpawnFn,
} from "./secrets-manager-installer";

/**
 * Build a fake `ChildProcess`-like object that the installer can drive.
 *
 * Real `ChildProcess` is a complex EventEmitter with stdin/stdout/stderr; the
 * installer only touches `.stdout`, `.stderr`, `.stdin` (sometimes), `on`,
 * `once`, `kill`. Returning a duck type with those parts is enough.
 */
interface FakeChildOptions {
  stdoutLines?: readonly string[];
  stderrLines?: readonly string[];
  exitCode?: number;
  spawnError?: Error;
}

function makeFakeChild(options: FakeChildOptions): ChildProcess {
  const stdout = new Readable({ read: () => undefined });
  const stderr = new Readable({ read: () => undefined });
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const listenerOnce = (
    event: string,
    fn: (...args: unknown[]) => void,
  ): ChildProcess => {
    handlers[event] = handlers[event] ?? [];
    handlers[event].push((...args) => {
      fn(...args);
    });
    return child;
  };
  const child = {
    stdout,
    stderr,
    stdin: { end: () => undefined },
    on: listenerOnce,
    once: listenerOnce,
    off: () => child,
    kill: () => true,
  } as unknown as ChildProcess;

  // Drive the lifecycle on next tick: error first if requested, otherwise
  // push the stdout/stderr lines, end the streams, then emit close.
  setImmediate(() => {
    if (options.spawnError) {
      for (const fn of handlers.error ?? []) fn(options.spawnError);
      return;
    }
    for (const line of options.stdoutLines ?? []) {
      stdout.push(`${line}\n`);
    }
    stdout.push(null);
    for (const line of options.stderrLines ?? []) {
      stderr.push(`${line}\n`);
    }
    stderr.push(null);
    let drained = 0;
    const onDrain = () => {
      drained++;
      if (drained === 2) {
        for (const fn of handlers.close ?? []) fn(options.exitCode ?? 0);
      }
    };
    stdout.on("end", onDrain);
    stderr.on("end", onDrain);
  });

  return child;
}

async function newManager(workDir: string) {
  const vault = createVault({
    workDir,
    masterKey: inMemoryMasterKey(generateMasterKey()),
  });
  return createManager({ vault });
}

describe("SecretsManagerInstaller — install", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-installer-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("rejects manual install methods", async () => {
    const installer = new SecretsManagerInstaller({
      manager: await newManager(workDir),
    });
    expect(() =>
      installer.startInstall("protonpass", {
        kind: "manual",
        instructions: "x",
        url: "https://example.com",
      }),
    ).toThrow(/manual/i);
  });

  it("streams stdout lines and resolves with done on exit 0", async () => {
    const spawn = vi.fn<SpawnFn>().mockImplementation((cmd, args) => {
      expect(cmd).toBe("brew");
      expect([...args]).toEqual(["install", "--cask", "1password-cli"]);
      return makeFakeChild({
        stdoutLines: ["==> Downloading", "==> Installing"],
        exitCode: 0,
      });
    });

    const installer = new SecretsManagerInstaller({
      manager: await newManager(workDir),
      spawn,
    });
    const snapshot = installer.startInstall("1password", {
      kind: "brew",
      package: "1password-cli",
      cask: true,
    });

    const events: string[] = [];
    await new Promise<void>((resolve) => {
      installer.subscribeJob(snapshot.id, (event) => {
        if (event.type === "log") events.push(`log:${event.line}`);
        if (event.type === "status") events.push(`status:${event.status}`);
        if (event.type === "done") {
          events.push(`done:${event.exitCode}`);
          resolve();
        }
      });
    });

    expect(events).toContain("status:running");
    expect(events).toContain("log:==> Downloading");
    expect(events).toContain("log:==> Installing");
    expect(events).toContain("done:0");

    const final = installer.getJob(snapshot.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.exitCode).toBe(0);
  });

  it("emits error event on non-zero exit", async () => {
    const spawn = vi.fn<SpawnFn>().mockImplementation(() =>
      makeFakeChild({
        stderrLines: ["error: brew not found"],
        exitCode: 1,
      }),
    );
    const installer = new SecretsManagerInstaller({
      manager: await newManager(workDir),
      spawn,
    });
    const snapshot = installer.startInstall("bitwarden", {
      kind: "npm",
      package: "@bitwarden/cli",
    });

    const errorMsg = await new Promise<string>((resolve) => {
      installer.subscribeJob(snapshot.id, (event) => {
        if (event.type === "error") resolve(event.message);
      });
    });
    expect(errorMsg).toMatch(/exit.*1/);
    expect(installer.getJob(snapshot.id)?.status).toBe("failed");
  });

  it("invokes the correct argv per method kind", async () => {
    const spawn = vi
      .fn<SpawnFn>()
      .mockImplementation(() => makeFakeChild({ exitCode: 0 }));
    const installer = new SecretsManagerInstaller({
      manager: await newManager(workDir),
      spawn,
    });

    installer.startInstall("bitwarden", {
      kind: "brew",
      package: "bitwarden-cli",
      cask: false,
    });
    installer.startInstall("bitwarden", {
      kind: "npm",
      package: "@bitwarden/cli",
    });

    // Wait one tick for the spawn calls to land — startInstall defers via setImmediate.
    await new Promise((r) => setImmediate(r));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual([
      "brew",
      ["install", "bitwarden-cli"],
    ]);
    expect(spawn.mock.calls[1]?.slice(0, 2)).toEqual([
      "npm",
      ["install", "-g", "@bitwarden/cli"],
    ]);
  });
});

describe("SecretsManagerInstaller — sign-in", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-signin-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("1Password: persists the session token from `op account add --raw`", async () => {
    const spawn = vi.fn<SpawnFn>().mockImplementationOnce((cmd, args) => {
      expect(cmd).toBe("op");
      expect(args).toContain("--raw");
      expect(args).toContain("--email");
      expect(args).toContain("user@example.com");
      return makeFakeChild({
        stdoutLines: ["dummy-op-session-token"],
        exitCode: 0,
      });
    });

    const manager = await newManager(workDir);
    const installer = new SecretsManagerInstaller({ manager, spawn });

    const result = await installer.signIn({
      backendId: "1password",
      email: "user@example.com",
      secretKey: "AAAA-BBBBBB-CCCCCC-DDDDDD-EEEEEE-FFFFFF",
      masterPassword: "supersecret",
    });

    expect(result).toEqual({
      backendId: "1password",
      sessionStored: true,
      message: expect.stringContaining("user@example.com"),
    });
    expect(await installer.getSession("1password")).toBe(
      "dummy-op-session-token",
    );
  });

  it("Bitwarden: runs login then unlock and persists the unlock token", async () => {
    const spawn = vi.fn<SpawnFn>();
    spawn.mockImplementationOnce((cmd, args, opts) => {
      expect(cmd).toBe("bw");
      expect([...args]).toEqual(["login", "--apikey"]);
      expect(opts.env?.BW_CLIENTID).toBe("client-id-123");
      expect(opts.env?.BW_CLIENTSECRET).toBe("client-secret-xyz");
      return makeFakeChild({
        stdoutLines: ["You are logged in!"],
        exitCode: 0,
      });
    });
    spawn.mockImplementationOnce((cmd, args, opts) => {
      expect(cmd).toBe("bw");
      expect([...args]).toEqual([
        "unlock",
        "--raw",
        "--passwordenv",
        "BW_PASSWORD",
      ]);
      expect(opts.env?.BW_PASSWORD).toBe("master-pwd");
      return makeFakeChild({
        stdoutLines: ["dummy-bw-unlock-token"],
        exitCode: 0,
      });
    });

    const manager = await newManager(workDir);
    const installer = new SecretsManagerInstaller({ manager, spawn });

    const result = await installer.signIn({
      backendId: "bitwarden",
      masterPassword: "master-pwd",
      bitwardenClientId: "client-id-123",
      bitwardenClientSecret: "client-secret-xyz",
    });

    expect(result.sessionStored).toBe(true);
    expect(await installer.getSession("bitwarden")).toBe(
      "dummy-bw-unlock-token",
    );
  });

  it("Bitwarden: tolerates 'already logged in' from the login step", async () => {
    const spawn = vi.fn<SpawnFn>();
    spawn.mockImplementationOnce(() =>
      makeFakeChild({
        stderrLines: ["You are already logged in as user@example.com"],
        exitCode: 1,
      }),
    );
    spawn.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: ["second-unlock-token"],
        exitCode: 0,
      }),
    );

    const manager = await newManager(workDir);
    const installer = new SecretsManagerInstaller({ manager, spawn });

    const result = await installer.signIn({
      backendId: "bitwarden",
      masterPassword: "x",
      bitwardenClientId: "id",
      bitwardenClientSecret: "secret",
    });
    expect(result.message).toMatch(/already/i);
    expect(await installer.getSession("bitwarden")).toBe("second-unlock-token");
  });

  it("Bitwarden: surfaces unlock failure as a thrown error", async () => {
    const spawn = vi.fn<SpawnFn>();
    spawn.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: ["You are logged in!"],
        exitCode: 0,
      }),
    );
    spawn.mockImplementationOnce(() =>
      makeFakeChild({
        stderrLines: ["Invalid master password"],
        exitCode: 1,
      }),
    );

    const installer = new SecretsManagerInstaller({
      manager: await newManager(workDir),
      spawn,
    });
    await expect(
      installer.signIn({
        backendId: "bitwarden",
        masterPassword: "wrong",
        bitwardenClientId: "id",
        bitwardenClientSecret: "secret",
      }),
    ).rejects.toThrow(/bw unlock failed/i);
  });

  it("rejects sign-in for protonpass (vendor CLI is in beta)", async () => {
    const installer = new SecretsManagerInstaller({
      manager: await newManager(workDir),
      spawn: vi.fn(),
    });
    await expect(
      installer.signIn({
        backendId: "protonpass",
        masterPassword: "x",
      }),
    ).rejects.toThrow(/protonpass/);
  });

  it("rejects 1Password without secretKey", async () => {
    const installer = new SecretsManagerInstaller({
      manager: await newManager(workDir),
      spawn: vi.fn(),
    });
    await expect(
      installer.signIn({
        backendId: "1password",
        email: "x@y.z",
        masterPassword: "p",
      }),
    ).rejects.toThrow(/secretKey/i);
  });

  it("signOut clears the persisted session", async () => {
    const spawn = vi
      .fn<SpawnFn>()
      .mockImplementation(() =>
        makeFakeChild({ stdoutLines: ["tok"], exitCode: 0 }),
      );
    const manager = await newManager(workDir);
    const installer = new SecretsManagerInstaller({ manager, spawn });
    await installer.signIn({
      backendId: "1password",
      email: "u@e.com",
      secretKey: "AAA",
      masterPassword: "p",
    });
    expect(await installer.getSession("1password")).toBe("tok");
    await installer.signOut("1password");
    expect(await installer.getSession("1password")).toBeNull();
  });
});
