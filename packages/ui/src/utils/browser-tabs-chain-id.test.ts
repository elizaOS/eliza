import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { BROWSER_TAB_PRELOAD_SCRIPT } from "./browser-tabs-renderer-registry";

describe("injected wallet chain id", () => {
  it("does not switch to mainnet when the hex chain id has junk", async () => {
    const dom = new JSDOM("<html><body></body></html>", {
      url: "https://dapp.invalid",
      runScripts: "outside-only",
    });
    const win = dom.window as unknown as {
      eval(source: string): void;
      ethereum: {
        chainId: string;
        request(args: {
          method: string;
          params: Array<{ chainId: string }>;
        }): Promise<unknown>;
      };
      __electrobunSendToHost(payload: {
        type: string;
        requestId: number;
      }): void;
      __elizaWalletReply(id: number, payload: unknown): void;
    };
    win.__electrobunSendToHost = (payload) => {
      if (payload.type !== "__elizaWalletRequest") return;
      win.__elizaWalletReply(payload.requestId, { result: null });
    };
    try {
      win.eval(BROWSER_TAB_PRELOAD_SCRIPT);
      await win.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x89" }],
      });
      expect(win.ethereum.chainId).toBe("0x89");
      await expect(
        win.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x1g" }],
        }),
      ).rejects.toThrow(/valid chainId/);
      expect(win.ethereum.chainId).toBe("0x89");
      await expect(
        win.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "1.5" }],
        }),
      ).rejects.toThrow(/valid chainId/);
      expect(win.ethereum.chainId).toBe("0x89");
    } finally {
      dom.window.close();
    }
  });
});
