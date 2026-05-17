import { describe, expect, it, vi } from "vitest";
import {
  type ElectrobunCryptoWindow,
  installElectrobunCryptoReadyGuards,
} from "./bridge/electrobun-crypto-ready";

describe("Electrobun preload crypto readiness guards", () => {
  it("does nothing when the native websocket RPC globals are absent", () => {
    const globalWindow: ElectrobunCryptoWindow = {};

    expect(installElectrobunCryptoReadyGuards(globalWindow)).toBe(false);
    expect(globalWindow.__electrobun_encrypt).toBeUndefined();
    expect(globalWindow.__electrobun_decrypt).toBeUndefined();
  });

  it("queues early encrypt and decrypt calls until the built-in preload installs crypto", async () => {
    vi.useFakeTimers();
    try {
      const globalWindow: ElectrobunCryptoWindow = {
        __electrobunWebviewId: 1,
        __electrobunRpcSocketPort: 50_000,
      };

      expect(
        installElectrobunCryptoReadyGuards(globalWindow, {
          timeoutMs: 1_000,
          pollIntervalMs: 10,
        }),
      ).toBe(true);

      const encryptPromise = globalWindow.__electrobun_encrypt?.("hello");
      const decryptPromise = globalWindow.__electrobun_decrypt?.(
        "payload",
        "iv",
        "tag",
      );

      const builtInEncrypt = vi.fn(async (message: string) => ({
        encryptedData: `encrypted:${message}`,
        iv: "iv",
        tag: "tag",
      }));
      const builtInDecrypt = vi.fn(
        async (encryptedData: string, iv: string, tag: string) =>
          `decrypted:${encryptedData}:${iv}:${tag}`,
      );

      await vi.advanceTimersByTimeAsync(20);
      globalWindow.__electrobun_encrypt = builtInEncrypt;
      globalWindow.__electrobun_decrypt = builtInDecrypt;
      await vi.advanceTimersByTimeAsync(10);

      await expect(encryptPromise).resolves.toEqual({
        encryptedData: "encrypted:hello",
        iv: "iv",
        tag: "tag",
      });
      await expect(decryptPromise).resolves.toBe("decrypted:payload:iv:tag");
      expect(builtInEncrypt).toHaveBeenCalledWith("hello");
      expect(builtInDecrypt).toHaveBeenCalledWith("payload", "iv", "tag");
    } finally {
      vi.useRealTimers();
    }
  });
});
