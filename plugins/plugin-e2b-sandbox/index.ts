/**
 * Plugin registration for the E2B remote sandbox backend.
 *
 * The host capability router owns provider selection; this package contributes
 * only the E2B factory service so agents can opt into e2b.dev filesystem,
 * terminal, and git sandboxes.
 */

import type { Plugin } from "@elizaos/core";
import { E2BSandboxFactoryService } from "./services/e2b-sandbox-factory-service";
export const e2bSandboxPlugin: Plugin = {
  name: "e2b-sandbox",
  description:
    "E2B (e2b.dev) cloud sandbox backend for the remote capability router — filesystem, terminal, and git in a vendor sandbox.",
  services: [E2BSandboxFactoryService],
};

export default e2bSandboxPlugin;

export {
  E2BSandboxFactoryService,
  E2BSandboxSdkClient,
} from "./services/e2b-sandbox-factory-service";
