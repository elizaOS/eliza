// Shared DLMM module export to avoid ESM/CJS interop issues in the SDK.
import { createRequire } from "node:module";
import type DLMMDefault from "@meteora-ag/dlmm";

export type { LbPosition } from "@meteora-ag/dlmm";

type DLMMConstructor = typeof DLMMDefault;
type DLMMModule = {
  default?: DLMMConstructor;
  autoFillYByStrategy: typeof import("@meteora-ag/dlmm").autoFillYByStrategy;
  StrategyType: typeof import("@meteora-ag/dlmm").StrategyType;
};

const require = createRequire(import.meta.url);
const dlmmModule = require("@meteora-ag/dlmm") as DLMMModule;
const DLMM = (dlmmModule.default ?? dlmmModule) as DLMMConstructor;
const { autoFillYByStrategy, StrategyType } = dlmmModule;

export { autoFillYByStrategy, DLMM, StrategyType };
