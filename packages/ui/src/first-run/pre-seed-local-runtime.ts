/**
 * Pre-seed the AOSP ElizaOS APK when the device itself is the local agent.
 *
 * Branded device images (`ElizaOS/<tag>` UA marker) ARE the agent: their
 * native shell auto-starts the on-device service unconditionally
 * (ElizaAgentService.shouldAutoStart), so the renderer commits it as the
 * startup target on first frame instead of falling back to cloud-connect.
 *
 * Stock-phone sideload builds are deliberately NOT pre-seeded (#14390): a
 * fresh install must land in onboarding and pick a runtime — the runtime
 * chooser is enabled by default on those builds (first-run-runtime-flag.ts)
 * and the finish path starts the service on demand once the user commits to
 * the local runtime. Pre-committing "local" here booted the bundled agent on
 * phones that cannot sustain it (a 4 GB device wedges boot for the full 180 s
 * startup budget) before the user had chosen anything.
 */

import { isAospElizaUserAgent } from "../platform/aosp-user-agent";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeModeForServerTarget,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";

export { isAospElizaUserAgent } from "../platform/aosp-user-agent";

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
    // error-policy:J3 corrupt persisted server blob — treat as "none" so the
    // pre-seed can write a fresh one
    return false;
  }
}

function writeLocalAgentActiveServer(): void {
  if (typeof window === "undefined") return;
  const payload = {
    id: ANDROID_LOCAL_AGENT_SERVER_ID,
    kind: "remote" as const,
    label: ANDROID_LOCAL_AGENT_LABEL,
    apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
  };
  try {
    window.localStorage.setItem(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // error-policy:J6 storage blocked (embedded shells) — the pre-seed is an
    // optimization; first-run still resolves the server interactively
  }
}

function isBrandedAndroidDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return isAospElizaUserAgent(navigator.userAgent);
}

export function preSeedAndroidLocalRuntimeIfFresh(): boolean {
  if (!isBrandedAndroidDevice()) return false;
  // Respect an explicit cloud/remote choice, but treat null or "local" as
  // seedable: a branded image may carry a "local" mode with no active server
  // yet (so the dashboard would otherwise fall back to cloud-connect).
  const persistedMode = readPersistedMobileRuntimeMode();
  if (persistedMode != null && persistedMode !== "local") return false;
  if (hasPersistedActiveServer()) return false;

  persistMobileRuntimeModeForServerTarget("local");
  writeLocalAgentActiveServer();
  return true;
}
