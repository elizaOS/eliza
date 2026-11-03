import { connectReadOnly, disconnectReadOnly, proveReadOnly, shortAddress } from "./wallet-client.ts";

type Choice = "phantom" | "solflare";

const api = {
  shortAddress,
  async connect(choice: Choice) {
    return connectReadOnly(choice);
  },
  async disconnect(choice: Choice) {
    await disconnectReadOnly(choice);
  },
  async prove(choice: Choice) {
    return proveReadOnly(choice);
  },
};

declare global {
  interface Window {
    ValhallaWallet: typeof api;
  }
}

window.ValhallaWallet = api;
