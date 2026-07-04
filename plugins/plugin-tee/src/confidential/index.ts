import { registerTeeEvidenceProviderFactory } from "@elizaos/agent/services/tee-evidence-provider";
import { logger, type Plugin } from "@elizaos/core";
import { createDstackTeeProvider } from "./dstack-tee-provider.ts";

export * from "./cove-quote.ts";
export * from "./cove-quote-x509.ts";
export * from "./dstack-tee-provider.ts";

/**
 * Register the dstack/CoVE evidence provider with the host boot-gate seam
 * (`@elizaos/agent/services/tee-evidence-provider`). The host boot gate then
 * resolves this provider instead of importing the concrete dstack/CoVE code
 * directly. Idempotent — the last registration wins.
 */
export function registerDstackEvidenceProvider(): void {
  registerTeeEvidenceProviderFactory((options) =>
    createDstackTeeProvider(options ?? {}),
  );
}

/**
 * Confidential-VM TEE deployment plugin. A CVM distribution profile loads this
 * plugin; its `init` registers the dstack/CoVE evidence provider with the host
 * boot-gate seam. Because registration flows through the seam, trunk services
 * never import this deployment-specific code — desktop/mobile builds that do
 * not load this plugin do not compile the dstack/CoVE stack, while the boot
 * gate stays fail-closed when no provider is registered.
 */
export const dstackConfidentialTeePlugin: Plugin = {
  name: "tee-dstack-confidential",
  description:
    "Registers the dstack/CoVE TEE evidence provider with the host boot-gate seam for confidential-VM deployments.",
  async init(): Promise<void> {
    registerDstackEvidenceProvider();
    logger.info(
      "[tee-dstack-confidential] Registered dstack/CoVE evidence provider with the host boot-gate seam.",
    );
  },
};
