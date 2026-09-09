/**
 * Persists a newly issued bearer credential across the active server and its
 * matching profile so every reconnect path observes the same authenticated
 * target. Pairing and bootstrap exchange both route through this boundary.
 */

import { setStorageValue } from "../bridge/storage-bridge";
import {
  getActiveProfile,
  updateAgentProfile,
  updateAgentProfileDurably,
  upsertAndActivateAgentProfileDurably,
} from "./agent-profiles";
import {
  createPersistedActiveServer,
  isPersistedActiveServerAllowed,
  loadPersistedActiveServer,
  type PersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

export async function persistActiveServerCredential(
  token: string,
  pairedApiBase?: string,
  options: {
    revalidate?: () => void;
    /** Own server-write receipt only; companion persistence can still fail. */
    onActiveServerPersisted?: (server: PersistedActiveServer) => void;
  } = {},
): Promise<void> {
  const activeServer = loadPersistedActiveServer();
  let expectedServer = JSON.stringify(activeServer);
  let expectedProfile = options.revalidate
    ? JSON.stringify(getActiveProfile())
    : null;
  const validate = () => {
    options.revalidate?.();
    if (
      options.revalidate &&
      (JSON.stringify(loadPersistedActiveServer()) !== expectedServer ||
        JSON.stringify(getActiveProfile()) !== expectedProfile)
    )
      throw new Error("Active credential selection changed");
  };
  validate();
  const explicitPairingBase = pairedApiBase?.trim() || null;
  const sameOriginPairingBase =
    (!activeServer || activeServer.kind === "local") &&
    typeof window !== "undefined" &&
    (window.location.protocol === "http:" ||
      window.location.protocol === "https:")
      ? window.location.origin
      : null;
  const pairingBase = explicitPairingBase ?? sameOriginPairingBase;
  const fallbackRemote = pairingBase
    ? createPersistedActiveServer({
        kind: "remote",
        apiBase: pairingBase,
        accessToken: token,
      })
    : null;
  // An explicit pairing base is the credential authority. A stale active
  // Cloud/profile selection must never redirect that newly minted remote
  // bearer into its own record.
  const credentialTarget =
    fallbackRemote ??
    (activeServer && activeServer.kind !== "local"
      ? { ...activeServer, accessToken: token }
      : null);
  if (
    credentialTarget &&
    options.revalidate &&
    !isPersistedActiveServerAllowed(credentialTarget)
  )
    throw new Error(
      "Active credential target is outside the build-pinned runtime",
    );

  if (credentialTarget) {
    // Preserve server-before-profile ordering: an interrupted server write
    // must not have published the companion credential already.
    if (!options.revalidate) savePersistedActiveServer(credentialTarget);
    await setStorageValue(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify(credentialTarget),
      options.revalidate ? { revalidate: validate } : undefined,
    );
    expectedServer = JSON.stringify(credentialTarget);
    validate();
    options.onActiveServerPersisted?.(credentialTarget);
  }

  validate();
  const activeProfile = getActiveProfile();
  const sameCredentialTarget =
    activeProfile &&
    credentialTarget &&
    activeProfile.kind === credentialTarget.kind &&
    activeProfile.apiBase?.replace(/\/+$/, "") ===
      credentialTarget.apiBase?.replace(/\/+$/, "");
  if (sameCredentialTarget && activeProfile) {
    const updated = await updateAgentProfileDurably(
      activeProfile.id,
      { accessToken: token },
      validate,
    );
    expectedProfile = JSON.stringify(updated);
  } else if (credentialTarget?.kind === "remote") {
    const updated = await upsertAndActivateAgentProfileDurably(
      {
        kind: "remote",
        label: credentialTarget.label,
        apiBase: credentialTarget.apiBase,
        accessToken: token,
      },
      validate,
    );
    expectedProfile = JSON.stringify(updated);
  }
  validate();
}

/**
 * Removes only the rejected bearer from the active target and profile. Other
 * saved targets keep their credentials so one expired agent cannot sign the
 * user out of every configured runtime.
 */
export function scrubRejectedActiveServerCredential(token: string): void {
  const rejected = token.trim();
  if (!rejected) return;

  const activeServer = loadPersistedActiveServer();
  if (activeServer?.accessToken === rejected) {
    const { accessToken: _rejected, ...serverWithoutToken } = activeServer;
    savePersistedActiveServer(serverWithoutToken);
  }

  const activeProfile = getActiveProfile();
  if (activeProfile?.accessToken === rejected) {
    updateAgentProfile(activeProfile.id, { accessToken: undefined });
  }
}
