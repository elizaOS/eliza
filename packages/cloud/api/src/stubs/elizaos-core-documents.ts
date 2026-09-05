/**
 * Fails explicitly when the host-only Core documents plugin is selected in
 * the Cloud API Worker. Document ingestion belongs on the agent sidecar because
 * the canonical service requires filesystem and DNS-pinned transport APIs.
 */
import { ElizaError, type Plugin } from "@elizaos/core/edge";

export const documentsPluginCore: Plugin = {
  name: "documents-unavailable-on-worker",
  description:
    "Explicit Worker boundary for the host-only documents capability.",
  async init() {
    throw new ElizaError(
      "The documents capability is unavailable in the Cloud API Worker; route document work through the agent-server sidecar.",
      {
        code: "DOCUMENTS_CAPABILITY_UNAVAILABLE_ON_WORKER",
        context: { runtime: "cloudflare-worker" },
      },
    );
  },
};
