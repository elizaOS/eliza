import type { AwarenessContributor } from "@elizaos/agent";
// opinion contributor deferred to feat/bsc-opinion-markets PR
import { cloudContributor } from "./cloud";
import { connectorsContributor } from "./connectors";
import { featuresContributor } from "./features";
import { permissionsContributor } from "./permissions";
import { pluginHealthContributor } from "./plugin-health";
import { providerContributor } from "./provider";
import { runtimeContributor } from "./runtime";
import { walletContributor } from "./wallet";

export const builtinContributors: AwarenessContributor[] = [
  runtimeContributor,
  permissionsContributor,
  walletContributor,
  providerContributor,
  pluginHealthContributor,
  connectorsContributor,
  cloudContributor,
  featuresContributor,
];
