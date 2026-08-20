/**
 * Deterministic mocked child-process coverage for the Codex device-login
 * lifecycle. The harness uses in-memory streams and isolated real temporary
 * directories; it never invokes Codex, a provider, or the network.
 */

import { EventEmitter } from "node:events";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const rmSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  rmSyncMock.mockImplementation(actual.rmSync);
  return { ...actual, rmSync: rmSyncMock };
});

import {
  codexDeviceLoginUsesShell,
  startCodexDeviceLogin,
} from "./codex-device.ts";

interface FakeChild {
  process: EventEmitter;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

const temporaryHomes: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mockChild(): FakeChild {
  const process = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  Object.assign(process, { stdout, stderr, kill });
  spawnMock.mockReturnValue(process);
  return { process, stdout, stderr, kill };
}

function spawnedCodexHome(): string {
  const options: unknown = spawnMock.mock.calls[0]?.[2];
  if (!isRecord(options) || !isRecord(options.env)) {
    throw new Error("Codex spawn options did not include an environment");
  }
  const codexHome = options.env.CODEX_HOME;
  if (typeof codexHome !== "string") {
    throw new Error("Codex spawn environment did not include CODEX_HOME");
  }
  temporaryHomes.push(codexHome);
  return codexHome;
}

function emitPrompt(child: FakeChild): void {
  child.stdout.write("Visit https://auth.openai.com/codex/device\n");
  child.stderr.write("Enter code ABCD-12345\n");
}

function accessToken(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

afterEach(() => {
  for (const temporaryHome of temporaryHomes) {
    if (existsSync(temporaryHome)) {
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  }
  temporaryHomes.length = 0;
  spawnMock.mockReset();
  rmSyncMock.mockClear();
});

describe("startCodexDeviceLogin", () => {
  it("uses the command shell only for the Windows npm shim", () => {
    expect(codexDeviceLoginUsesShell("win32")).toBe(true);
    expect(codexDeviceLoginUsesShell("linux")).toBe(false);
    expect(codexDeviceLoginUsesShell("darwin")).toBe(false);
  });

  it("rejects when the CLI closes successfully before emitting the prompt", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();

    child.process.emit("spawn");
    child.process.emit("close", 0, null);

    await expect(start).rejects.toThrow(
      "exited with code 0 before emitting a device URL and user code",
    );
    await expect(start).rejects.toMatchObject({
      code: "codex_device.prompt_missing",
    });
    expect(existsSync(codexHome)).toBe(false);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
    expect(rmSyncMock).toHaveBeenCalledWith(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 25,
    });
  });

  it("rejects a nonzero close with exit context", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();

    child.process.emit("spawn");
    child.process.emit("close", 7, null);

    await expect(start).rejects.toThrow("exited with code 7");
    await expect(start).rejects.toMatchObject({
      code: "codex_device.process_failed",
      context: { exitCode: 7, signal: null },
    });
    expect(existsSync(codexHome)).toBe(false);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });

  it("settles once when spawn emits an error before close", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();
    const spawnError = new Error("codex executable unavailable");

    child.process.emit("error", spawnError);
    child.process.emit("close", -2, null);

    await expect(start).rejects.toMatchObject({
      code: "codex_device.spawn_failed",
      cause: spawnError,
    });
    expect(existsSync(codexHome)).toBe(false);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });

  it("translates cleanup failure without throwing from an early-close callback", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();
    const cleanupFailure = new Error("simulated cleanup failure");
    rmSyncMock.mockImplementationOnce(() => {
      throw cleanupFailure;
    });

    child.process.emit("spawn");
    expect(() => child.process.emit("close", 0, null)).not.toThrow();

    const error = await start.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ElizaError);
    expect(error).toMatchObject({
      code: "codex_device.cleanup_failed",
      cause: cleanupFailure,
      context: {
        phase: "prompt_missing",
        maxRetries: 2,
        retryDelayMs: 25,
      },
    });
    expect(existsSync(codexHome)).toBe(true);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });

  it("waits for complete output and resolves credentials after a normal login", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["login", "--device-auth"],
      expect.objectContaining({
        shell: process.platform === "win32",
      }),
    );

    child.process.emit("spawn");
    child.process.emit("exit", 0, null);
    emitPrompt(child);
    const flow = await start;
    const exp = 2_000_000_000;
    writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: accessToken(exp),
          refresh_token: "refresh-fixture",
          id_token: "id-fixture",
        },
      }),
    );

    child.process.emit("close", 0, null);

    await expect(flow.credentials).resolves.toEqual({
      access: accessToken(exp),
      refresh: "refresh-fixture",
      expires: exp * 1000,
      idToken: "id-fixture",
    });
    expect(flow).toMatchObject({
      authUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-12345",
    });
    expect(existsSync(codexHome)).toBe(false);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });

  it("rejects credentials instead of fulfilling them when final cleanup fails", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();
    child.process.emit("spawn");
    emitPrompt(child);
    const flow = await start;
    const exp = 2_000_000_000;
    writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: accessToken(exp),
          refresh_token: "refresh-fixture",
        },
      }),
    );
    const cleanupFailure = new Error("simulated cleanup failure");
    rmSyncMock.mockImplementationOnce(() => {
      throw cleanupFailure;
    });

    expect(() => child.process.emit("close", 0, null)).not.toThrow();

    const error = await flow.credentials.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ElizaError);
    expect(error).toMatchObject({
      code: "codex_device.cleanup_failed",
      cause: cleanupFailure,
      context: {
        phase: "credentials_complete",
        maxRetries: 2,
        retryDelayMs: 25,
      },
    });
    expect(String(error)).not.toContain("refresh-fixture");
    expect(existsSync(codexHome)).toBe(true);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });

  it("kills and rejects credentials when a started flow is cancelled", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();
    child.process.emit("spawn");
    emitPrompt(child);
    const flow = await start;

    flow.close();
    child.process.emit("close", null, "SIGTERM");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(flow.credentials).rejects.toThrow("exited with SIGTERM");
    await expect(flow.credentials).rejects.toMatchObject({
      code: "codex_device.process_failed",
      context: { exitCode: null, signal: "SIGTERM" },
    });
    expect(existsSync(codexHome)).toBe(false);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });

  it("waits for close when cancellation emits a post-spawn kill error", async () => {
    const child = mockChild();
    const start = startCodexDeviceLogin();
    const codexHome = spawnedCodexHome();
    child.process.emit("spawn");
    emitPrompt(child);
    const flow = await start;
    const killError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    child.kill.mockImplementationOnce(() => {
      child.process.emit("error", killError);
      return false;
    });

    flow.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(existsSync(codexHome)).toBe(true);
    await expect(
      Promise.race([
        flow.credentials.then(
          () => "fulfilled",
          () => "rejected",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");

    child.process.emit("close", null, "SIGTERM");

    await expect(flow.credentials).rejects.toMatchObject({
      code: "codex_device.process_failed",
      context: { exitCode: null, signal: "SIGTERM" },
    });
    expect(existsSync(codexHome)).toBe(false);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });
});
