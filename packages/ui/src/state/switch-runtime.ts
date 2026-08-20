/**
 * Non-destructive runtime switch: repoints the app at a different agent
 * profile (local / cloud / remote) by updating the active-profile and
 * active-server records and clearing chat drafts, without wiping persisted
 * state. Consumed by the runtime picker and connect deep-links.
 */
import { client } from "../api";
import {
  isMobileLocalAgentIpcBase,
  persistMobileRuntimeModeForServerTarget,
} from "../first-run/mobile-runtime-mode";
import { activeServerKindToFirstRunRuntimeTarget } from "../first-run/runtime-target";
import { getFrontendPlatform } from "../platform/platform-guards";
import { loadRuntimeCredential } from "../platform/runtime-credential-store";
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
  resolvedCredential?: string | null,
): SwitchRuntimeResult {
  const registry = loadAgentProfileRegistry();
  const profile = registry.profiles.find((p) => p.id === profileId);
  if (!profile) return { ok: false, reason: "not-found" };

  if (
    profile.kind === "remote" &&
    !isTrustedRestoreApiBaseUrl(profile.apiBase)
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

  const accessToken = resolvedCredential ?? profile.accessToken ?? null;
  const server = createPersistedActiveServer({
    kind: profile.kind,
    id: activeServerIdForAgentProfile(profile),
    apiBase: profile.apiBase,
    accessToken: profile.credentialRef ? undefined : (accessToken ?? undefined),
    credentialRef: profile.credentialRef,
    label: profile.label,
    cloudRuntimeAgentId: profile.cloudRuntimeAgentId,
    cloudRuntime: profile.cloudRuntime,
  });
  if (!persistAgentProfileSelection(profile.id, server)) {
    return { ok: false, reason: "persistence-failed" };
  }

  // Cloud / remote runtimes get the seamless in-place base + token swap.
  // Local runtimes are same-origin: re-point back to the app's own host and
  // CLEAR any prior remote/cloud bearer token — otherwise cloud→local leaves
  // the live client stuck on the stale remote base + token for the rest of the
  // session (it only self-heals on reboot).
  if (profile.apiBase) {
    client.repointBaseUrl(profile.apiBase, accessToken);
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

  return { ok: true, profile };
}

/** Resolve a native secure-store credential before applying a saved runtime. */
export async function switchRuntimeWithStoredCredential(
  profileId: string,
): Promise<SwitchRuntimeResult> {
  const profile = loadAgentProfileRegistry().profiles.find(
    (candidate) => candidate.id === profileId,
  );
  if (!profile) return { ok: false, reason: "not-found" };
  const accessToken =
    profile.accessToken ??
    (profile.credentialRef
      ? await loadRuntimeCredential(profile.credentialRef)
      : null);
  return switchRuntimeNonDestructive(profileId, accessToken);
}
