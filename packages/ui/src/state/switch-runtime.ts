import { client } from "../api";
import type { AgentProfile } from "./agent-profile-types";
import { loadAgentProfileRegistry, setActiveProfileId } from "./agent-profiles";
import {
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import { isTrustedRestoreApiBaseUrl } from "./startup-phase-restore";

export type SwitchRuntimeResult =
  | { ok: true; profile: AgentProfile }
  | { ok: false; reason: "not-found" | "untrusted-remote" };

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
    !isTrustedRestoreApiBaseUrl(profile.apiBase)
  ) {
    return { ok: false, reason: "untrusted-remote" };
  }

  const server = createPersistedActiveServer({
    kind: profile.kind,
    id: profile.id,
    apiBase: profile.apiBase,
    accessToken: profile.accessToken,
    label: profile.label,
  });
  savePersistedActiveServer(server);
  setActiveProfileId(profile.id);

  // Local runtimes are same-origin (no apiBase) — nothing to re-point. Cloud /
  // remote runtimes get the seamless in-place base + token swap.
  if (profile.apiBase) {
    if (profile.accessToken) client.setToken(profile.accessToken);
    client.repointBaseUrl(profile.apiBase);
  }

  return { ok: true, profile };
}
