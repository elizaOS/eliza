import type { Provider } from "@elizaos/core";
import { batteryProvider } from "./battery";
import { perceptionProvider } from "./perception";
import { policyStatusProvider } from "./policyStatus";
import { robotStateProvider } from "./robotState";

export {
  batteryProvider,
  perceptionProvider,
  policyStatusProvider,
  robotStateProvider,
};

export const providers: Provider[] = [
  robotStateProvider,
  perceptionProvider,
  policyStatusProvider,
  batteryProvider,
];
