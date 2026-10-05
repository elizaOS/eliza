import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { BROWSER_TAB_PRELOAD_SCRIPT } from "./browser-tabs-renderer-registry";

it.each([
  { cluster: "localnet", chain: "solana:mainnet" },
  { cluster: 123 },
  { network: "localnet", rpcEndpoint: "https://api.mainnet-beta.solana.com" },
])(
  "preserves explicit network intent through the actual preload %j",
  async (options) => {
    const dom = new JSDOM("<html><body></body></html>", {
      url: "https://dapp.invalid",
      runScripts: "outside-only",
    });
    const win = dom.window as unknown as {
      eval(source: string): void;
      __electrobunSendToHost(payload: {
        type: string;
        requestId: number;
        params: { cluster: unknown };
      }): void;
      __elizaWalletReply(id: number, payload: unknown): void;
      solana: {
        signAndSendTransaction(
          transaction: Uint8Array,
          options: unknown,
        ): Promise<unknown>;
      };
    };
    let cluster: unknown;
    win.__electrobunSendToHost = (payload) => {
      if (payload.type !== "__elizaWalletRequest") return;
      cluster = payload.params.cluster;
      win.__elizaWalletReply(payload.requestId, {
        result: { signature: "test-signature" },
      });
    };
    try {
      win.eval(BROWSER_TAB_PRELOAD_SCRIPT);
      await win.solana.signAndSendTransaction(
        Object.assign(new dom.window.Uint8Array([1, 2, 3]), {
          cluster: "mainnet",
        }),
        options,
      );
      expect(cluster).toBe(
        "cluster" in options ? options.cluster : options.network,
      );
    } finally {
      dom.window.close();
    }
  },
);
