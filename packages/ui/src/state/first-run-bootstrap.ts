/**
 * Probes an existing local install on boot — detects a completed/partial
 * first-run config and resolves the initial active-server record so a returning
 * user skips re-onboarding. Reads via the injected probe client.
 */
import { isElizaCloudControlPlaneAgentlessBase } from "../utils/cloud-agent-base";
import { asRecord, readString } from "./config-readers";
import { asApiLikeError } from "./parsers";
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

/**
 * True when an existing-install probe failure means "the committed on-device
 * agent is still coming up", so the wait-for-boot loop should keep retrying
 * rather than surface it.
 *
 * A booting on-device agent reports "not up yet" only two ways: a
 * transport-level failure (the loopback/IPC socket refuses the connection or
 * the request times out — `kind` `network`/`timeout`) or a structured
 * `502`/`503`/`504` heartbeat (the iOS/Android native transports answer a
 * not-yet-ready kernel with a `503`; the same gateway-unavailable band the
 * backend poll treats as transient in `startup-phase-poll.ts`). Every other
 * outcome means the agent ANSWERED — an auth `401/403`, a real `500`, a `404`,
 * or a `parse` failure on malformed JSON — which is a genuine fault the caller
 * must see, never a reason to re-onboard a set-up user. An unrecognized
 * (non-`ApiError`) throw is treated as genuine for the same reason: masking an
 * unknown failure as "still booting" is exactly the sludge this guards against.
 */
export function isBootingAgentProbeError(err: unknown): boolean {
  const api = asApiLikeError(err);
  if (!api) return false;
  if (api.kind === "network" || api.kind === "timeout") return true;
  return api.status === 502 || api.status === 503 || api.status === 504;
}

/**
 * Interpret an agent that ANSWERED the first-run status probe. A completed
 * first-run — or a partial one whose persisted config already carries an
 * existing install — restores the local active server; anything else means the
 * agent is up but genuinely un-onboarded, so first-run proceeds normally.
 */
async function interpretAnsweredFirstRunStatus(
  client: ExistingFirstRunProbeClient,
  status: { complete: boolean },
): Promise<ExistingFirstRunProbeResult | null> {
  if (status.complete) {
    return {
      activeServer: LOCAL_ACTIVE_SERVER,
      detectedExistingInstall: true,
    } satisfies ExistingFirstRunProbeResult;
  }

  // error-policy:J4 same probe semantics — no readable config means "no
  // existing install detected", so onboarding proceeds.
  const config = await client.getConfig().catch(() => null);
  if (!hasPersistedExistingInstallConfig(config)) {
    return null;
  }

  return {
    activeServer: LOCAL_ACTIVE_SERVER,
    detectedExistingInstall: true,
  } satisfies ExistingFirstRunProbeResult;
}

/**
 * Whether the boot-time existing-install probe (GET /api/first-run/status +
 * /api/config) should run for `origin`. The probe detects a returning
 * local/self-hosted install so the user skips re-onboarding. On a bare Eliza
 * Cloud control-plane origin (app.elizacloud.ai, elizacloud.ai, …) the
 * same-origin API is the managed cloud endpoint: it requires auth and hosts no
 * unauthenticated local install to detect, so probing it only yields 401
 * console noise during fresh onboarding (#16242). Skip it there — the in-chat
 * first-run conductor owns Cloud sign-in.
 */
export function shouldProbeExistingLocalInstall(
  origin: string | null | undefined,
): boolean {
  return !isElizaCloudControlPlaneAgentlessBase(origin ?? "");
}

function currentOrigin(): string | null {
  return typeof window !== "undefined" ? window.location.origin : null;
}

export async function detectExistingFirstRunConnection(args: {
  client: ExistingFirstRunProbeClient;
  timeoutMs: number;
  /**
   * Set when a committed on-device runtime (mobile `local` / `cloud-hybrid`)
   * is persisted, so the native service IS bringing the bundled agent up. That
   * cold boot takes ~30s on a low-power phone — far longer than the single-shot
   * probe — so a still-booting agent must be waited out, not read as "no
   * install". When set, an unreachable probe (see {@link isBootingAgentProbeError})
   * is retried until the agent answers or the outer timeout fires; a genuine
   * probe fault (auth/5xx/malformed) is rethrown for the caller to surface. A
   * fresh install leaves this unset and keeps the fast single-shot: any failure
   * there legitimately means "not installed", and re-onboarding is correct.
   */
  waitForBootingAgent?: boolean;
}): Promise<ExistingFirstRunProbeResult | null> {
  if (!args.client.apiAvailable) {
    return null;
  }

  // Skip the probe on a bare Cloud control-plane origin: the same-origin API is
  // auth-gated, so first-run/status + config only 401 during fresh onboarding
  // (#16242). Gated here rather than at the restore call site so every caller
  // inherits it and the guard is testable in isolation.
  if (!shouldProbeExistingLocalInstall(currentOrigin())) {
    return null;
  }

  const timeoutToken = Symbol("first-run-bootstrap-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const probe = async (): Promise<ExistingFirstRunProbeResult | null> => {
    for (;;) {
      if (timedOut) return null;

      let status: { complete: boolean } | null;
      try {
        status = await args.client.getFirstRunStatus();
      } catch (err) {
        if (!args.waitForBootingAgent) {
          // error-policy:J4 fresh-install probe — an unreachable agent means
          // "no existing install detected" and first-run proceeds normally.
          return null;
        }
        // The committed on-device agent is still booting only when the probe
        // never reached a live agent; a genuine fault is surfaced, not retried
        // into first-run.
        if (!isBootingAgentProbeError(err)) throw err;
        if (timedOut) return null;
        await new Promise((resolve) =>
          setTimeout(resolve, BOOTING_AGENT_RETRY_MS),
        );
        continue;
      }

      return interpretAnsweredFirstRunStatus(args.client, status);
    }
  };
  const result = await Promise.race([
    probe(),
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
