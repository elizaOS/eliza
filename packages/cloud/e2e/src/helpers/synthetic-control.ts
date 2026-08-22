/** Opens Cloud E2E synthetic worlds through the same manifested control session used by scenarios. */

import {
  SyntheticControlClient,
  SyntheticControlSession,
  type SyntheticManifest,
} from "@elizaos/shared/synthetic-control";

export interface OpenCloudSyntheticWorldOptions {
  controlUrl: string;
  controlToken: string;
  manifest: SyntheticManifest;
  owner?: string;
  timeoutMs?: number;
}

export function openCloudSyntheticWorld(
  options: OpenCloudSyntheticWorldOptions,
): Promise<SyntheticControlSession> {
  return SyntheticControlSession.open({
    client: new SyntheticControlClient({
      baseUrl: options.controlUrl,
      token: options.controlToken,
      timeoutMs: options.timeoutMs,
    }),
    manifest: options.manifest,
    owner: options.owner ?? "cloud-e2e",
  });
}
