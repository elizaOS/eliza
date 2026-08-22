/** Opens an explicitly manifested synthetic-world session through the shared subprocess control client. */

export type {
  SyntheticControlCommand,
  SyntheticControlResponse,
  SyntheticManifest,
  SyntheticResetReceipt,
} from "@elizaos/shared/synthetic-control";
export {
  SyntheticControlClient,
  SyntheticControlProtocolError,
  SyntheticControlSession,
} from "@elizaos/shared/synthetic-control";

import {
  SyntheticControlClient,
  SyntheticControlSession,
  type SyntheticManifest,
} from "@elizaos/shared/synthetic-control";

export interface OpenScenarioSyntheticWorldOptions {
  controlUrl: string;
  controlToken: string;
  manifest: SyntheticManifest;
  owner?: string;
  timeoutMs?: number;
}

/** Requires both an endpoint and a concrete manifest; a profile string alone cannot seed a run. */
export async function openScenarioSyntheticWorld(
  options: OpenScenarioSyntheticWorldOptions,
): Promise<SyntheticControlSession> {
  return SyntheticControlSession.open({
    client: new SyntheticControlClient({
      baseUrl: options.controlUrl,
      namespace: options.manifest.namespace,
      token: options.controlToken,
      timeoutMs: options.timeoutMs,
    }),
    manifest: options.manifest,
    owner: options.owner ?? "scenario-runner",
  });
}
