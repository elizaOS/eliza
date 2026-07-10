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

/** Delay between existing-install probes while waiting for a booting agent. */
const BOOTING_AGENT_RETRY_MS = 1_000;

export async function detectExistingFirstRunConnection(args: {
  client: ExistingFirstRunProbeClient;
  timeoutMs: number;
  /**
   * True when a committed on-device runtime (mobile `cloud-hybrid` / `local`)
   * is persisted, so the native service WILL bring the bundled agent up. The
   * agent's cold boot takes ~30s on a low-power phone (LP3) — far longer than
   * the single-shot probe — so without waiting, a returning hybrid user is
   * dropped back into first-run on every cold launch while the agent is still
   * booting. When set, keep retrying the unreachable probe until the agent
   * answers or the outer timeout fires. A genuinely fresh install leaves this
   * false and keeps the fast single-shot (no re-onboarding delay).
   */
  waitForBootingAgent?: boolean;
}): Promise<ExistingFirstRunProbeResult | null> {
  if (!args.client.apiAvailable) {
    return null;
  }

  const timeoutToken = Symbol("first-run-bootstrap-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const result = await Promise.race([
    (async () => {
      for (;;) {
        if (timedOut) {
          return null;
        }
        // error-policy:J4 existing-install probe — an unreachable agent means
        // "no existing install detected" and first-run proceeds normally,
        // unless we are waiting for a known-booting on-device agent (below).
        const status = await args.client.getFirstRunStatus().catch(() => null);
        if (status) {
          if (status.complete) {
            return {
              activeServer: LOCAL_ACTIVE_SERVER,
              detectedExistingInstall: true,
            } satisfies ExistingFirstRunProbeResult;
          }

          // error-policy:J4 same probe semantics — the agent answered but has
          // no existing install, so first-run proceeds normally.
          const config = await args.client.getConfig().catch(() => null);
          if (!hasPersistedExistingInstallConfig(config)) {
            return null;
          }

          return {
            activeServer: LOCAL_ACTIVE_SERVER,
            detectedExistingInstall: true,
          } satisfies ExistingFirstRunProbeResult;
        }

        // Agent unreachable. A fresh install proceeds straight to first-run; a
        // committed on-device runtime waits for its still-booting agent (the
        // outer Promise.race caps the total wait at timeoutMs).
        if (!args.waitForBootingAgent) {
          return null;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, BOOTING_AGENT_RETRY_MS),
        );
      }
    })(),
    new Promise<typeof timeoutToken>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        resolve(timeoutToken);
      }, args.timeoutMs);
    }),
  ]);
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
  }

  return result === timeoutToken ? null : result;
}
