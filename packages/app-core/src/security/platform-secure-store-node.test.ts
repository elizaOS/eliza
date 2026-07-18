/**
 * Exercises the Node secure-store adapters with deterministic command and
 * platform boundaries, including macOS, Linux, unavailable-host, and opt-in
 * policy behavior without touching a real OS credential store.
 */

import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execFileAsync = vi.fn();
  const execFile = vi.fn();
  const keychainWrites: Array<[string, string, string]> = [];
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsync,
  });
  return {
    execFile,
    execFileAsync,
    keychainWrites,
    spawn: vi.fn(),
    writeMacOSKeychainPassword: vi.fn(
      async (service: string, account: string, password: string) => {
        keychainWrites.push([service, account, password]);
      },
    ),
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("@elizaos/vault/macos-keychain-password", () => ({
  writeMacOSKeychainPassword: mocks.writeMacOSKeychainPassword,
}));

let createNodePlatformSecureStore: typeof import("./platform-secure-store-node.js").createNodePlatformSecureStore;
let formatMacOSKeychainWriteError: typeof import("./platform-secure-store-node.js").formatMacOSKeychainWriteError;
let isNodePlatformSecureStoreDefaultAvailable: typeof import("./platform-secure-store-node.js").isNodePlatformSecureStoreDefaultAvailable;
let isWalletOsStoreReadEnabled: typeof import("./platform-secure-store-node.js").isWalletOsStoreReadEnabled;

type SpawnChild = EventEmitter & {
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdin: {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
};

const originalPath = process.env.PATH;
const originalWalletOsStore = process.env.ELIZA_WALLET_OS_STORE;
const tempDirs: string[] = [];

beforeAll(async () => {
  // app-core deliberately runs Vitest with module isolation disabled. Reload
  // this adapter after installing its OS-process boundary mocks so an earlier
  // app-core import cannot retain the real child_process bindings.
  vi.resetModules();
  ({
    createNodePlatformSecureStore,
    formatMacOSKeychainWriteError,
    isNodePlatformSecureStoreDefaultAvailable,
    isWalletOsStoreReadEnabled,
  } = await import("./platform-secure-store-node.js"));
});

function platform(value: NodeJS.Platform) {
  return vi.spyOn(process, "platform", "get").mockReturnValue(value);
}

function execResult(stdout = "", stderr = "") {
  mocks.execFileAsync.mockResolvedValueOnce({ stdout, stderr });
}

function execError(stderr: string, code?: number) {
  mocks.execFileAsync.mockRejectedValueOnce(
    Object.assign(new Error(stderr), { stderr, code }),
  );
}

function spawnResult({
  code = 0,
  stderr = "",
  error,
}: {
  code?: number;
  stderr?: string;
  error?: Error;
} = {}): SpawnChild {
  const child = new EventEmitter() as SpawnChild;
  child.stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  child.stdin = { write: vi.fn(), end: vi.fn() };
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      if (stderr) child.stderr.emit("data", stderr);
      if (error) child.emit("error", error);
      else child.emit("close", code);
    });
    return child;
  });
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.execFile.mockReset();
  mocks.execFileAsync.mockReset();
  mocks.spawn.mockReset();
  mocks.keychainWrites.length = 0;
  mocks.writeMacOSKeychainPassword.mockReset();
  mocks.writeMacOSKeychainPassword.mockImplementation(
    async (service: string, account: string, password: string) => {
      mocks.keychainWrites.push([service, account, password]);
    },
  );
  if (originalWalletOsStore === undefined) {
    delete process.env.ELIZA_WALLET_OS_STORE;
  } else {
    process.env.ELIZA_WALLET_OS_STORE = originalWalletOsStore;
  }
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("formatMacOSKeychainWriteError", () => {
  it("preserves the helper message when stderr is empty", () => {
    const error = Object.assign(
      new Error("macOS Keychain prompt helper exited without a code (SIGKILL)"),
      { stderr: "" },
    );

    expect(formatMacOSKeychainWriteError(error)).toBe(error.message);
  });

  it("prefers bounded stderr when the helper produced a diagnostic", () => {
    const error = Object.assign(new Error("fallback"), {
      stderr: `security failed: ${"x".repeat(400)}`,
    });

    expect(formatMacOSKeychainWriteError(error)).toHaveLength(300);
    expect(formatMacOSKeychainWriteError(error)).toMatch(
      /^security failed: x+$/,
    );
  });

  it("stringifies non-Error failures", () => {
    expect(formatMacOSKeychainWriteError("plain failure")).toBe(
      "plain failure",
    );
  });
});

describe("platform selection", () => {
  it("selects each backend and keeps the unavailable backend explicit", async () => {
    const platformSpy = platform("darwin");
    expect(createNodePlatformSecureStore().backend).toBe("macos_keychain");

    platformSpy.mockReturnValue("linux");
    expect(createNodePlatformSecureStore().backend).toBe(
      "linux_secret_service",
    );

    platformSpy.mockReturnValue("freebsd");
    const unavailable = createNodePlatformSecureStore();
    expect(unavailable.backend).toBe("none");
    await expect(unavailable.isAvailable()).resolves.toBe(false);
    await expect(
      unavailable.get("vault", "wallet.evm_private_key"),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(
      unavailable.set("vault", "wallet.evm_private_key", "secret"),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(
      unavailable.delete("vault", "wallet.evm_private_key"),
    ).resolves.toBeUndefined();
  });
});

describe("macOS Keychain adapter", () => {
  it("probes, reads, writes, and deletes through the expected commands", async () => {
    platform("darwin");
    const store = createNodePlatformSecureStore();

    execResult();
    await expect(store.isAvailable()).resolves.toBe(true);

    execResult("  key-value  \n");
    await expect(store.get("vault", "wallet.evm_private_key")).resolves.toEqual(
      { ok: true, value: "key-value" },
    );

    await expect(
      store.set("vault", "wallet.evm_private_key", "new-value"),
    ).resolves.toEqual({ ok: true });
    expect(mocks.keychainWrites).toEqual([
      ["ai.elizaos.agent.vault", "vault:wallet.evm_private_key", "new-value"],
    ]);

    execResult();
    await expect(
      store.delete("vault", "wallet.evm_private_key"),
    ).resolves.toBeUndefined();
    expect(mocks.execFileAsync).toHaveBeenLastCalledWith("security", [
      "delete-generic-password",
      "-s",
      "ai.elizaos.agent.vault",
      "-a",
      "vault:wallet.evm_private_key",
    ]);
  });

  it("maps probe, lookup, write, and delete failures at the adapter boundary", async () => {
    platform("darwin");
    const store = createNodePlatformSecureStore();

    execError("missing binary");
    await expect(store.isAvailable()).resolves.toBe(false);

    execResult("   \n");
    await expect(store.get("vault", "wallet.evm_private_key")).resolves.toEqual(
      { ok: false, reason: "not_found" },
    );

    execError("The specified item could not be found");
    await expect(store.get("vault", "wallet.evm_private_key")).resolves.toEqual(
      { ok: false, reason: "not_found" },
    );

    execError("User canceled the operation");
    await expect(store.get("vault", "wallet.evm_private_key")).resolves.toEqual(
      { ok: false, reason: "denied" },
    );

    execError("authorization denied", 44);
    await expect(
      store.get("vault", "wallet.evm_private_key"),
    ).resolves.toMatchObject({ ok: false, reason: "denied" });

    execError("unexpected failure", 2);
    await expect(store.get("vault", "wallet.evm_private_key")).resolves.toEqual(
      {
        ok: false,
        reason: "error",
        message: "unexpected failure",
      },
    );

    mocks.writeMacOSKeychainPassword.mockRejectedValueOnce(
      Object.assign(new Error("helper failed"), { stderr: "pty failed" }),
    );
    await expect(
      store.set("vault", "wallet.evm_private_key", "new-value"),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      message: "pty failed",
    });

    execError("already absent");
    await expect(
      store.delete("vault", "wallet.evm_private_key"),
    ).resolves.toBeUndefined();
  });
});

describe("Linux Secret Service adapter", () => {
  it("detects secret-tool and completes read, write, and delete operations", async () => {
    platform("linux");
    const binDir = mkdtempSync(path.join(os.tmpdir(), "secret-tool-bin-"));
    tempDirs.push(binDir);
    const secretTool = path.join(binDir, "secret-tool");
    writeFileSync(secretTool, "#!/bin/sh\nexit 0\n");
    chmodSync(secretTool, 0o755);
    process.env.PATH = binDir;

    const store = createNodePlatformSecureStore();
    await expect(store.isAvailable()).resolves.toBe(true);
    expect(isNodePlatformSecureStoreDefaultAvailable()).toBe(true);

    execResult("  linux-value \n");
    await expect(
      store.get("vault", "wallet.solana_private_key"),
    ).resolves.toEqual({ ok: true, value: "linux-value" });

    const child = spawnResult();
    await expect(
      store.set("vault", "wallet.solana_private_key", "linux-secret"),
    ).resolves.toEqual({ ok: true });
    expect(child.stdin.write).toHaveBeenCalledWith("linux-secret\n", "utf8");
    expect(child.stdin.end).toHaveBeenCalledOnce();

    execResult();
    await expect(
      store.delete("vault", "wallet.solana_private_key"),
    ).resolves.toBeUndefined();
  });

  it("maps lookup, write, and delete failures without fabricating success", async () => {
    platform("linux");
    process.env.PATH = "";
    const store = createNodePlatformSecureStore();
    await expect(store.isAvailable()).resolves.toBe(false);
    expect(isNodePlatformSecureStoreDefaultAvailable()).toBe(false);

    execResult("  \n");
    await expect(
      store.get("vault", "wallet.solana_private_key"),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    execError("lookup failed", 1);
    await expect(
      store.get("vault", "wallet.solana_private_key"),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    execError("secret not found", 2);
    await expect(
      store.get("vault", "wallet.solana_private_key"),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    execError("service unavailable", 2);
    await expect(
      store.get("vault", "wallet.solana_private_key"),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      message: "service unavailable",
    });

    spawnResult({ code: 2, stderr: "write denied" });
    await expect(
      store.set("vault", "wallet.solana_private_key", "secret\n"),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      message: "write denied",
    });

    spawnResult({ error: new Error("spawn failed") });
    await expect(
      store.set("vault", "wallet.solana_private_key", "secret"),
    ).resolves.toMatchObject({ ok: false, reason: "error" });

    execError("already absent");
    await expect(
      store.delete("vault", "wallet.solana_private_key"),
    ).resolves.toBeUndefined();
  });
});

describe("wallet secure-store read policy", () => {
  it("honors explicit true/false values before platform defaults", () => {
    platform("freebsd");
    for (const value of ["1", "true", "ON", " yes "]) {
      process.env.ELIZA_WALLET_OS_STORE = value;
      expect(isWalletOsStoreReadEnabled()).toBe(true);
    }
    for (const value of ["0", "false", "OFF", " no "]) {
      process.env.ELIZA_WALLET_OS_STORE = value;
      expect(isWalletOsStoreReadEnabled()).toBe(false);
    }
  });

  it("falls back to the selected platform's availability", () => {
    const platformSpy = platform("darwin");
    process.env.ELIZA_WALLET_OS_STORE = "unexpected";
    expect(isWalletOsStoreReadEnabled()).toBe(true);

    platformSpy.mockReturnValue("freebsd");
    delete process.env.ELIZA_WALLET_OS_STORE;
    expect(isWalletOsStoreReadEnabled()).toBe(false);
  });
});
