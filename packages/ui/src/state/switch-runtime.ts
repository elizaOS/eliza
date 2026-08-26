/**
 * Non-destructive runtime switch: repoints the app at a different agent
 * profile (local / cloud / remote) by updating the active-profile and
 * active-server records and clearing chat drafts, without wiping persisted
 * state. Consumed by the runtime picker and connect deep-links.
 */
import { logger } from "@elizaos/logger";
import { client } from "../api";
import {
  isMobileLocalAgentIpcBase,
  persistMobileRuntimeModeForServerTarget,
} from "../first-run/mobile-runtime-mode";
import { activeServerKindToFirstRunRuntimeTarget } from "../first-run/runtime-target";
import { getFrontendPlatform } from "../platform/platform-guards";
import type { AgentProfile } from "./agent-profile-types";
import {
  activeServerIdForAgentProfile,
  loadAgentProfileRegistry,
  persistAgentProfileSelection,
} from "./agent-profiles";
import { clearAllChatDrafts } from "./ChatComposerContext.hooks";
import { createPersistedActiveServer } from "./persistence";
import {
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "./runtime-url-trust";

export type SwitchRuntimeResult =
  | { ok: true; profile: AgentProfile }
  | {
      ok: false;
      reason:
        | "not-found"
        | "persistence-failed"
        | "untrusted-cloud"
        | "untrusted-remote";
    };

export type RuntimeAuthoritySwitchPhase = "before" | "after";
type RuntimeAuthoritySwitchListener = (
  phase: RuntimeAuthoritySwitchPhase,
) => void;
const runtimeAuthoritySwitchListeners =
  new Set<RuntimeAuthoritySwitchListener>();

/**
 * Subscribe to explicit non-destructive runtime authority changes. Unlike the
 * client's raw base-url signal, this excludes temporary probes and the
 * shared-to-dedicated handoff that must preserve the live transcript.
 */
export function subscribeRuntimeAuthoritySwitch(
  listener: RuntimeAuthoritySwitchListener,
): () => void {
  runtimeAuthoritySwitchListeners.add(listener);
  return () => runtimeAuthoritySwitchListeners.delete(listener);
}

function notifyRuntimeAuthoritySwitch(
  phase: RuntimeAuthoritySwitchPhase,
): void {
  for (const listener of runtimeAuthoritySwitchListeners) {
    try {
      listener(phase);
    } catch (error) {
      logger.error(
        { error },
        "[switch-runtime] authority-switch listener failed",
      );
    }
  }
}

function hasValidNativeRemoteBinding(profile: AgentProfile): boolean {
  if (profile.connectionMode === "relay") {
    return Boolean(
      profile.remoteRelay &&
        profile.apiBase ===
          `eliza-remote://session/${profile.remoteRelay.sessionId}`,
    );
  }
  if (profile.connectionMode === "ssh") {
    return Boolean(
      profile.ssh &&
        profile.credentialRef === profile.id &&
        profile.apiBase === `eliza-ssh://runtime/${profile.id}`,
    );
  }
  return false;
}

/**
 * Switch the active runtime IN PLACE — the "My Runtimes" non-destructive switch.
 *
 * Generalizes {@link silentlyRepointToDedicated} to any saved runtime profile
 * (local / cloud-dedicated / VPS-remote): persist it as the restorable active
 * server (so a reboot restores this runtime), mark it active in the
 * agent-profile registry, and re-point the live client with `repointBaseUrl`
 * (NOT `setBaseUrl` → no `SWITCH_AGENT` dispatch, no draft-clear, no
 * StartupScreen flash). The chat surface stays mounted throughout.
 *
 * Remote runtimes are **trust-gated**: a public URL is rejected; loopback,
 * RFC1918, CGNAT (`100.64/10`), tailscale (`*.ts.net` / `100.x`), and
 * same-origin are allowed — matching the startup restore guard
 * (`isTrustedRestoreApiBaseUrl`). This is why the cockpit "phone drives a remote
 * runtime" path expects the laptop/VPS over tailscale, not a bare public URL.
 */
export function switchRuntimeNonDestructive(
  profileId: string,
): SwitchRuntimeResult {
  const registry = loadAgentProfileRegistry();
  const profile = registry.profiles.find((p) => p.id === profileId);
  if (!profile) return { ok: false, reason: "not-found" };

  if (
    profile.kind === "remote" &&
    !(
      hasValidNativeRemoteBinding(profile) ||
      (profile.connectionMode !== "relay" &&
        profile.connectionMode !== "ssh" &&
        isTrustedRestoreApiBaseUrl(profile.apiBase))
    )
  ) {
    return { ok: false, reason: "untrusted-remote" };
  }
  if (
    profile.kind === "cloud" &&
    !isTrustedCloudApiBaseUrl(
      profile.apiBase,
      profile.cloudRuntimeAgentId ?? profile.cloudAgentId,
    )
  ) {
    return { ok: false, reason: "untrusted-cloud" };
  }

  const server = createPersistedActiveServer({
    kind: profile.kind,
    id: activeServerIdForAgentProfile(profile),
    apiBase: profile.apiBase,
    accessToken: profile.accessToken,
    label: profile.label,
    cloudRuntimeAgentId: profile.cloudRuntimeAgentId,
    cloudRuntime: profile.cloudRuntime,
  });
  if (!persistAgentProfileSelection(profile.id, server)) {
    return { ok: false, reason: "persistence-failed" };
  }

  // Persistence made the authority switch durable. Purge authority-local
  // caches now, before the live client can repoint or hydrate colliding ids.
  notifyRuntimeAuthoritySwitch("before");

  // Cloud / remote runtimes get the seamless in-place base + token swap.
  // Local runtimes are same-origin: re-point back to the app's own host and
  // CLEAR any prior remote/cloud bearer token — otherwise cloud→local leaves
  // the live client stuck on the stale remote base + token for the rest of the
  // session (it only self-heals on reboot).
  if (profile.apiBase) {
    client.repointBaseUrl(profile.apiBase, profile.accessToken ?? null);
  } else if (typeof window !== "undefined") {
    client.setToken(null);
    client.repointBaseUrl(window.location.origin);
  }

  // A runtime change is an account change → clear per-conversation composer
  // drafts so a draft doesn't bleed across runtimes (the canonical
  // switchAgentProfile clears them too).
  clearAllChatDrafts();

  // On mobile, persist the runtime mode so the switch SURVIVES A REBOOT —
  // otherwise reconcileMobileRestoredActiveServer wipes the active server on the
  // next boot when the mode disagrees. Mirrors AppContext.switchAgentProfile's
  // mobile branch exactly (the on-device agent is a `remote` profile on a local
  // IPC base, so treat that as "local").
  const platform = getFrontendPlatform();
  if (platform === "android" || platform === "ios") {
    const target =
      profile.kind === "local" || isMobileLocalAgentIpcBase(profile.apiBase)
        ? "local"
        : activeServerKindToFirstRunRuntimeTarget(profile.kind);
    persistMobileRuntimeModeForServerTarget(target);
  }

  // The live client now points at the new authority and every synchronous
  // switch mutation has completed. Consumers may safely hydrate that
  // authority's conversation list and initial transcript.
  notifyRuntimeAuthoritySwitch("after");

  return { ok: true, profile };
}
