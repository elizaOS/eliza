/**
 * Waits for the deployed renderer's authoritative Cloud API boot value so the
 * staging proof cannot mistake the synchronous production default for a build.
 */

import { resolveDirectCloudAuthApiBase } from "@elizaos/ui/api/direct-cloud-endpoints";

export interface RendererCloudApiObservation {
  cloudBase: string;
  apiOrigin: string;
}

interface RendererCloudApiReadinessOptions {
  readCloudBase: () => Promise<string>;
  expectedApiOrigin: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

function observeRendererCloudApi(
  cloudBase: string,
): RendererCloudApiObservation {
  const normalizedCloudBase = cloudBase.trim();
  if (!normalizedCloudBase) {
    return { cloudBase: "", apiOrigin: "" };
  }

  try {
    return {
      cloudBase: normalizedCloudBase,
      apiOrigin: new URL(resolveDirectCloudAuthApiBase(normalizedCloudBase))
        .origin,
    };
  } catch {
    // error-policy:J3 the exact malformed build value remains visible in the
    // failed readiness receipt instead of becoming a plausible fallback.
    return {
      cloudBase: normalizedCloudBase,
      apiOrigin: `<unparseable: ${normalizedCloudBase}>`,
    };
  }
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function waitForRendererCloudApiOrigin(
  options: RendererCloudApiReadinessOptions,
): Promise<RendererCloudApiObservation> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let lastObservation: RendererCloudApiObservation = {
    cloudBase: "",
    apiOrigin: "",
  };

  while (true) {
    lastObservation = observeRendererCloudApi(await options.readCloudBase());
    if (lastObservation.apiOrigin === options.expectedApiOrigin) {
      return lastObservation;
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Renderer Cloud API did not become ready within ${timeoutMs}ms: last base ${lastObservation.cloudBase || "<unset>"} resolved to ${lastObservation.apiOrigin || "<empty>"}; expected ${options.expectedApiOrigin}`,
      );
    }

    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}
