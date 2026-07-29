/** Public plugin entry registering Aomi session orchestration, planner context, and the confirmed action. */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { aomiAction } from "./action.js";
import { aomiProvider } from "./provider.js";
import { registerAomiDirectRoute } from "./routing.js";
import { AomiService } from "./service.js";

export { aomiAction } from "./action.js";
export { type AomiConfig, readAomiConfig } from "./config.js";
export * from "./core-augmentation.js";
export { aomiProvider } from "./provider.js";
export {
  AOMI_DIRECT_ROUTE_TAG,
  looksLikeExplicitAomiRequest,
  registerAomiDirectRoute,
} from "./routing.js";
export {
  AOMI_SERVICE_TYPE,
  AomiService,
  type AomiServiceDependencies,
  type AomiServiceStatus,
} from "./service.js";
export type {
  AomiBoundary,
  AomiPendingOperation,
  AomiSession,
  AomiSessionFactory,
} from "./types.js";
export {
  executeWalletRequest,
  walletRequestPreview,
  walletRequestSupportError,
} from "./wallet.js";

export const aomiPlugin: Plugin = {
  name: "aomi",
  description:
    "Aomi on-chain agent delegation with Eliza wallet custody and explicit confirmation.",
  services: [AomiService],
  providers: [aomiProvider],
  actions: [aomiAction],
  init: (_config, runtime) => {
    registerAomiDirectRoute(runtime);
  },
  async dispose(runtime: IAgentRuntime) {
    const service = runtime.getService<AomiService>(AomiService.serviceType);
    await service?.stop();
  },
};

export default aomiPlugin;
