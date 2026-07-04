import type { Plugin } from "@elizaos/core";
import { E2BSandboxFactoryService } from "./services/e2b-sandbox-factory-service";

/**
 * `@elizaos/plugin-e2b-sandbox` — the `e2b.dev` vendor backend for the host
 * remote capability router.
 *
 * The router lives in the host (`@elizaos/agent`) and owns the provider-neutral
 * selection logic plus the eliza-cloud / home HTTP runners. The E2B SDK path
 * (and the `e2b` npm dependency) lives here: this plugin registers
 * {@link E2BSandboxFactoryService} under `E2B_SANDBOX_FACTORY_SERVICE_TYPE`, and
 * the router selects the `e2b` provider only when that service is present.
 *
 * Opt-in: enabled when the agent is configured for the `e2b` remote runner
 * (`ELIZA_CODING_REMOTE_RUNNER=e2b` / `ELIZA_E2B_REMOTE_RUNNER`), or by listing
 * the plugin in a character's plugin list.
 */
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
