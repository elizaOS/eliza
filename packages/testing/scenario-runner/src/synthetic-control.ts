/** Opens an explicitly manifested synthetic-world session through the shared subprocess control client. */

export type {
  SyntheticControlCommand,
  SyntheticControlResponse,
  SyntheticManifest,
  SyntheticResetReceipt,
} from "@elizaos/testing/synthetic-control";
export {
  SyntheticControlClient,
  SyntheticControlProtocolError,
  SyntheticControlSession,
} from "@elizaos/testing/synthetic-control";

import {
  SyntheticControlClient,
  SyntheticControlSession,
  type SyntheticManifest,
} from "@elizaos/testing/synthetic-control";

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
