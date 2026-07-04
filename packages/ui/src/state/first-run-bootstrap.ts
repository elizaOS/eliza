/**
 * Probes an existing local install on boot — detects a completed/partial
 * first-run config and resolves the initial active-server record so a returning
 * user skips re-onboarding. Reads via the injected probe client.
 */
import { asRecord, readString } from "./config-readers";
import {
  createPersistedActiveServer,
  type PersistedActiveServer,
} from "./persistence";
import { hasPartialSetupConnectionConfig } from "./setup-resume";
export interface ExistingFirstRunProbeClient {
  apiAvailable: boolean;
  getFirstRunStatus: () => Promise<{ complete: boolean }>;
  getConfig: () => Promise<Record<string, unknown> | null | undefined>;
}

export interface ExistingFirstRunProbeResult {
  activeServer: PersistedActiveServer;
  detectedExistingInstall: boolean;
}

const LOCAL_ACTIVE_SERVER = createPersistedActiveServer({ kind: "local" });

function hasPersistedExistingInstallConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (!config) {
    return false;
  }

  if (hasPartialSetupConnectionConfig(config)) {
    return true;
  }

  const meta = asRecord(config.meta);
  if (meta?.firstRunComplete === true) {
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

export async function detectExistingFirstRunConnection(args: {
  client: ExistingFirstRunProbeClient;
  timeoutMs: number;
}): Promise<ExistingFirstRunProbeResult | null> {
  if (!args.client.apiAvailable) {
    return null;
  }

  const timeoutToken = Symbol("first-run-bootstrap-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    (async () => {
      // error-policy:J4 existing-install probe — an unreachable agent means
      // "no existing install detected" and first-run proceeds normally
      const status = await args.client.getFirstRunStatus().catch(() => null);
      if (!status) {
        return null;
      }

      if (status.complete) {
        return {
          activeServer: LOCAL_ACTIVE_SERVER,
          detectedExistingInstall: true,
        } satisfies ExistingFirstRunProbeResult;
      }

      // error-policy:J4 same probe semantics — no readable config means "no
      // existing install detected"
      const config = await args.client.getConfig().catch(() => null);
      if (!hasPersistedExistingInstallConfig(config)) {
        return null;
      }

      return {
        activeServer: LOCAL_ACTIVE_SERVER,
        detectedExistingInstall: true,
      } satisfies ExistingFirstRunProbeResult;
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
