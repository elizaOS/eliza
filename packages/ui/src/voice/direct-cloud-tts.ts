import { ELIZA_CLOUD_DIRECT_API_BY_HOST } from "../cloud/shell/steward-url";

function resolveCloudWorkerBase(cloudBase: string): string {
  const normalized = cloudBase.replace(/\/+$/, "");
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return ELIZA_CLOUD_DIRECT_API_BY_HOST[host] ?? normalized;
  } catch {
    return normalized;
  }
}

export interface DirectCloudTtsRequest {
  url: string;
  authToken: string;
}

/**
 * Resolve an authenticated cloud-worker TTS request without assuming the
 * production origin. A missing token/base deliberately keeps callers on the
 * existing agent proxy path.
 */
export function resolveDirectCloudTtsRequest(input: {
  cloudApiBase: string | null | undefined;
  cloudAuthToken: string | null | undefined;
}): DirectCloudTtsRequest | null {
  const cloudApiBase = input.cloudApiBase?.trim();
  const authToken = input.cloudAuthToken?.trim();
  if (!cloudApiBase || !authToken) return null;

  const workerBase = resolveCloudWorkerBase(cloudApiBase)
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "");
  if (!/^https?:\/\//i.test(workerBase)) return null;

  return {
    url: `${workerBase}/api/v1/voice/tts`,
    authToken,
  };
}
