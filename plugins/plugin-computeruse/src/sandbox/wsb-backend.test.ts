import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxBackendUnavailableError } from "./types";
import { isWindowsSandboxAvailable, WSBBackend } from "./wsb-backend";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from "node:fs";

const mockedExistsSync = vi.mocked(existsSync);
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("isWindowsSandboxAvailable", () => {
  beforeEach(() => {
    mockedExistsSync.mockReset();
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
  });

  it("is false on non-Windows hosts regardless of the sandbox binary", () => {
    setPlatform("linux");
    mockedExistsSync.mockReturnValue(true);
    expect(isWindowsSandboxAvailable()).toBe(false);
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it("checks the WindowsSandbox.exe path on Windows hosts", () => {
    setPlatform("win32");
    mockedExistsSync.mockReturnValue(true);
    expect(isWindowsSandboxAvailable()).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith(
      "C:/Windows/System32/WindowsSandbox.exe",
    );
  });

  it("is false when the feature executable is missing", () => {
    setPlatform("win32");
    mockedExistsSync.mockReturnValue(false);
    expect(isWindowsSandboxAvailable()).toBe(false);
  });
});

describe("WSBBackend availability gate", () => {
  beforeEach(() => {
    setPlatform("linux");
    mockedExistsSync.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
  });

  it("throws SandboxBackendUnavailableError when unavailable and nothing is injected", () => {
    expect(() => new WSBBackend()).toThrow(SandboxBackendUnavailableError);
  });

  it("fails loudly with a message pointing at the fallback backend", () => {
    try {
      new WSBBackend();
      expect.unreachable("constructor should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxBackendUnavailableError);
      const e = err as SandboxBackendUnavailableError;
      expect(e.backend).toBe("wsb");
      expect(e.message).toContain("COMPUTER_USE_SANDBOX_BACKEND=docker");
    }
  });

  it("accepts an injected transport even when the sandbox is unavailable", () => {
    const transport = {} as never;
    expect(() => new WSBBackend({ transport })).not.toThrow();
  });

  it("accepts an injected launcher even when the sandbox is unavailable", () => {
    const launcher = {
      launch: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    expect(() => new WSBBackend({ launcher })).not.toThrow();
  });

  it("respects an explicit availability override", () => {
    setPlatform("linux");
    mockedExistsSync.mockReturnValue(false);
    expect(() => new WSBBackend({ available: true })).not.toThrow();
  });
});

describe("WSBBackend lifecycle", () => {
  let launcher: {
    launch: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    setPlatform("linux");
    mockedExistsSync.mockReset().mockReturnValue(false);
    launcher = {
      launch: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
  });

  it("launches the sandbox with the default RPC port", async () => {
    const backend = new WSBBackend({ launcher });
    await backend.start();
    expect(launcher.launch).toHaveBeenCalledWith({ rpcPort: 8000 });
  });

  it("launches with a custom RPC port", async () => {
    const backend = new WSBBackend({ launcher, rpcPort: 9001 });
    await backend.start();
    expect(launcher.launch).toHaveBeenCalledWith({ rpcPort: 9001 });
  });

  it("is idempotent: a second start does not relaunch the sandbox", async () => {
    const backend = new WSBBackend({ launcher });
    await backend.start();
    await backend.start();
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it("does not shut down a sandbox that was never started", async () => {
    const backend = new WSBBackend({ launcher });
    await backend.stop();
    expect(launcher.shutdown).not.toHaveBeenCalled();
  });

  it("shuts down the launcher exactly once per started session", async () => {
    const backend = new WSBBackend({ launcher });
    await backend.start();
    await backend.stop();
    await backend.stop();
    expect(launcher.shutdown).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh launch after stop", async () => {
    const backend = new WSBBackend({ launcher });
    await backend.start();
    await backend.stop();
    await backend.start();
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(launcher.shutdown).toHaveBeenCalledTimes(1);
  });

  it("builds the guest RPC URL from the configured rpcUrl", () => {
    const backend = new WSBBackend({
      launcher,
      rpcUrl: "http://host:7777/cua",
    });
    // TS private is erased at runtime; transport opts carry the resolved URL.
    const transport = (
      backend as unknown as { _transport: { opts: { url: string } } }
    )._transport;
    expect(transport.opts.url).toBe("http://host:7777/cua");
  });

  it("defaults the guest RPC URL to the local port", () => {
    const backend = new WSBBackend({ launcher });
    const transport = (
      backend as unknown as { _transport: { opts: { url: string } } }
    )._transport;
    expect(transport.opts.url).toBe("http://127.0.0.1:8000/cua");
  });
});
