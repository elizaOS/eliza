/**
 * EVM sub-plugin composed into `@elizaos/plugin-wallet`'s top-level
 * `walletPlugin` — not intended to be loaded standalone. Registers
 * `EVMService`, the EVM wallet/balance providers, the sign HTTP routes, and
 * the `WALLET` subactions promoted from `walletRouterAction`.
 */

import {
  type Action,
  type IAgentRuntime,
  promoteSubactionsToActions,
  type ServiceClass,
} from "@elizaos/core";
import type { HttpPlugin as Plugin } from "@elizaos/host/protocol";
import { walletRouterAction } from "../wallet-action";
import { tokenBalanceProvider } from "./providers/get-balance";
import { evmWalletProvider } from "./providers/wallet";
import { evmSignRoutes } from "./routes/sign";
import { EVMService } from "./service";

export { initWalletProvider, WalletProvider } from "./providers/wallet";
export type { SupportedChain } from "./types";
export const evmPlugin: Plugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider, tokenBalanceProvider],
  services: [EVMService] as ServiceClass[],
  actions: promoteSubactionsToActions(walletRouterAction as Action) as Action[],
  routes: evmSignRoutes,
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<EVMService>(EVMService.serviceType);
    await svc?.stop();
  },
};
export default evmPlugin;
