import { asRecord, readString } from "./config-readers";
import { hasPartialOnboardingConnectionConfig } from "./onboarding-resume";
import {
  createPersistedActiveServer,
  type PersistedActiveServer,
} from "./persistence";
export interface ExistingOnboardingProbeClient {
  apiAvailable: boolean;
  getOnboardingStatus: () => Promise<{ complete: boolean }>;
  getConfig: () => Promise<Record<string, unknown> | null | undefined>;
}

export interface ExistingOnboardingProbeResult {
  activeServer: PersistedActiveServer;
  detectedExistingInstall: boolean;
}

export interface DetectedProviderCandidate {
  id: string;
  apiKey?: string;
  authMode?: string;
  status?: string;
}

const LOCAL_ACTIVE_SERVER = createPersistedActiveServer({ kind: "local" });

function hasPersistedExistingInstallConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (!config) {
    return false;
  }

  if (hasPartialOnboardingConnectionConfig(config)) {
    return true;
  }

  const meta = asRecord(config.meta);
  if (meta?.onboardingComplete === true) {
    return true;
  }

  const agents = asRecord(config.agents);
  if (!agents) {
    return false;
  }

  const list = agents.list;
  if (Array.isArray(list) && list.length > 0) {
    return true;
  }

  const defaults = asRecord(agents.defaults);
  return Boolean(
    readString(defaults, "workspace") || readString(defaults, "adminEntityId"),
  );
}

export async function detectExistingOnboardingConnection(args: {
  client: ExistingOnboardingProbeClient;
  timeoutMs: number;
}): Promise<ExistingOnboardingProbeResult | null> {
  if (!args.client.apiAvailable) {
    return null;
  }

  const timeoutToken = Symbol("onboarding-bootstrap-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    (async () => {
      const status = await args.client.getOnboardingStatus().catch(() => null);
      if (!status) {
        return null;
      }

      if (status.complete) {
        return {
          activeServer: LOCAL_ACTIVE_SERVER,
          detectedExistingInstall: true,
        } satisfies ExistingOnboardingProbeResult;
      }

      const config = await args.client.getConfig().catch(() => null);
      if (!hasPersistedExistingInstallConfig(config)) {
        return null;
      }

      return {
        activeServer: LOCAL_ACTIVE_SERVER,
        detectedExistingInstall: true,
      } satisfies ExistingOnboardingProbeResult;
    })(),
    new Promise<typeof timeoutToken>((resolve) => {
      timeoutId = setTimeout(() => resolve(timeoutToken), args.timeoutMs);
    }),
  ]);
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
  }

  return result === timeoutToken ? null : result;
}

export function deriveDetectedProviderPrefill(
  detected: readonly DetectedProviderCandidate[],
): {
  serverTarget: "local";
  providerId: string;
  apiKey: string;
} | null {
  for (const candidate of detected) {
    const providerId = candidate.id.trim();
    const apiKey = candidate.apiKey?.trim() ?? "";
    if (providerId && apiKey) {
      return {
        serverTarget: "local",
        providerId,
        apiKey,
      };
    }
  }

  return null;
}
