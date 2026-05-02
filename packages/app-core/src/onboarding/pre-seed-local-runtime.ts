/**
 * Pre-seed helper for the ElizaOS APK boot flow.
 *
 * On the AOSP ElizaOS variant the device IS the on-device agent — there
 * is no choice for the user to make. `apps/app/src/main.tsx` calls
 * `preSeedAndroidLocalRuntimeIfFresh()` before React mounts, which writes
 * the persisted runtime mode + active server so `StartupShell` (and the
 * `RuntimeGate` ElizaOS branch) treat the device as already-onboarded
 * for the local agent.
 *
 * Implementation note: this file deliberately does NOT import from
 * `state/persistence` — that module's transitive dep graph is heavy
 * (pulls in i18n, themes, telegram). All this helper needs is one
 * localStorage write to `elizaos:active-server`. The shape is the
 * `PersistedActiveServer` JSON; the key matches `ACTIVE_SERVER_STORAGE_KEY`
 * in `state/persistence.ts`. Splitting the constant out of that file is
 * possible but invasive — keeping the literal in one extra place is the
 * lighter refactor.
 */

import {
  ANDROID_LOCAL_AGENT_API_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeModeForServerTarget,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";

// Mirror of `ACTIVE_SERVER_STORAGE_KEY` in `state/persistence.ts`. Split
// here so this file stays a leaf module — `state/persistence.ts` pulls in
// the entire UI state graph and would create a cycle through
// `bridge/storage-bridge`.
const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

function hasPersistedActiveServer(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { id?: unknown } | null;
    return (
      parsed != null &&
      typeof parsed === "object" &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    );
  } catch {
    return false;
  }
}

function writeLocalAgentActiveServer(): void {
  if (typeof window === "undefined") return;
  const payload = {
    id: ANDROID_LOCAL_AGENT_SERVER_ID,
    kind: "remote" as const,
    label: ANDROID_LOCAL_AGENT_LABEL,
    apiBase: ANDROID_LOCAL_AGENT_API_BASE,
  };
  try {
    window.localStorage.setItem(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // localStorage can be unavailable in embedded shells.
  }
}

/**
 * No-op when:
 *   - a persisted mode already exists (the user — or a previous boot —
 *     has made a deliberate choice; don't clobber it),
 *   - a persisted active server already exists (a remote/cloud target was
 *     wired up by some other path: deep link, Settings, prior session).
 *
 * Returns `true` when the pre-seed actually wrote anything, `false`
 * otherwise. The boolean is mainly for tests; callers can ignore it.
 *
 * Eliza Cloud and Remote remain reachable from Settings ▸ Runtime; that
 * surface is responsible for clearing both the persisted mode and the
 * persisted active server before re-opening the picker via the explicit
 * `?runtime=picker` override.
 */
export function preSeedAndroidLocalRuntimeIfFresh(): boolean {
  if (readPersistedMobileRuntimeMode() != null) return false;
  if (hasPersistedActiveServer()) return false;

  persistMobileRuntimeModeForServerTarget("local");
  writeLocalAgentActiveServer();
  return true;
}
