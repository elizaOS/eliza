/**
 * Unit tests for copy-api-key: drives the real copyApiKeyToClipboard contract
 * through its actual fallback chain (desktop bridge → async Clipboard API →
 * legacy execCommand) in jsdom, stubbing only the browser boundaries.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElectrobunRendererRpc } from "../../bridge/electrobun-rpc.ts";
import { copyApiKeyToClipboard } from "./copy-api-key.ts";

const KEY = "eliza_sk_9f2c4a7e1b8d4f60a3c5e7d9012b4a6f";

type Restore = () => void;
const restores: Restore[] = [];

function installOwnProperty(target: object, key: string, value: unknown): void {
  const existing = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
  });
  restores.push(() => {
    if (existing) Object.defineProperty(target, key, existing);
    else Reflect.deleteProperty(target, key);
  });
}

function installClipboard(writeText: ReturnType<typeof vi.fn>): void {
  installOwnProperty(window.navigator, "clipboard", { writeText });
}

function installExecCommand(
  impl: (...args: unknown[]) => unknown,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl);
  installOwnProperty(document, "execCommand", spy);
  return spy;
}

function installDesktopBridge(
  handler: (params?: unknown) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const handlerSpy = vi.fn(handler);
  const rpc: ElectrobunRendererRpc = {
    request: { desktopWriteToClipboard: handlerSpy },
    onMessage: vi.fn(),
    offMessage: vi.fn(),
  };
  installOwnProperty(
    window as Window & { __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc },
    "__ELIZA_ELECTROBUN_RPC__",
    rpc,
  );
  return handlerSpy;
}

afterEach(() => {
  while (restores.length) restores.pop()?.();
  vi.restoreAllMocks();
});

describe("copy-api-key", () => {
  it("copies the one-time plaintext key through the async Clipboard API", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    installClipboard(writeText);
    const execCommand = installExecCommand(() => true);

    await expect(copyApiKeyToClipboard(KEY)).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("prefers an installed desktop bridge and leaves the web rungs untouched", async () => {
    const bridgeHandler = installDesktopBridge(async () => undefined);
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    installClipboard(writeText);
    const execCommand = installExecCommand(() => true);

    await expect(copyApiKeyToClipboard(KEY)).resolves.toBeUndefined();

    expect(bridgeHandler).toHaveBeenCalledTimes(1);
    expect(bridgeHandler).toHaveBeenCalledWith({ text: KEY });
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls through to the Clipboard API when the bridged write reports no bridge", async () => {
    installDesktopBridge(async () => null);
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    installClipboard(writeText);
    const execCommand = installExecCommand(() => true);

    await expect(copyApiKeyToClipboard(KEY)).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to the legacy execCommand path when the async write is denied", async () => {
    installClipboard(
      vi.fn<(text: string) => Promise<void>>(async () => {
        throw new Error("NotAllowedError: write denied");
      }),
    );
    const execCommand = installExecCommand((command) => command === "copy");

    await expect(copyApiKeyToClipboard(KEY)).resolves.toBeUndefined();

    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("rejects with the unavailable error once every rung fails", async () => {
    installDesktopBridge(async () => null);
    installClipboard(
      vi.fn<(text: string) => Promise<void>>(async () => {
        throw new Error("document not focused");
      }),
    );
    installExecCommand(() => false);

    await expect(copyApiKeyToClipboard(KEY)).rejects.toThrow(
      "Clipboard API unavailable.",
    );
  });

  it("treats a throwing legacy path as a failed rung, not a crash", async () => {
    installDesktopBridge(async () => null);
    installClipboard(
      vi.fn<(text: string) => Promise<void>>(async () => {
        throw new Error("permissions policy blocked");
      }),
    );
    installExecCommand(() => {
      throw new Error("execCommand blocked");
    });

    await expect(copyApiKeyToClipboard(KEY)).rejects.toThrow(
      "Clipboard API unavailable.",
    );
  });
});
