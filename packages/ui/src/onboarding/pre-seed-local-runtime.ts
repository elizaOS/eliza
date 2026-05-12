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
 * Stock-Android Capacitor APKs (installed from the Play Store onto a
 * non-branded handset) MUST NOT pre-seed: the user actively chooses
 * Cloud / Remote / Local from `RuntimeGate`, and there is no on-device
 * agent listening at 127.0.0.1:31337 unless the user explicitly picks
 * Local (which then goes through `ElizaAgentService.shouldAutoStart`).
 * Pre-seeding on stock Android would skip the picker and dead-end the
 * boot in a "Failed to connect to /127.0.0.1:31337" loop.
 *
 * Detection: we look for `ElizaOS/<tag>` in the WebView user-agent,
 * which `MainActivity.applyBrandUserAgentMarkers` appends only when
<<<<<<< HEAD
 * `ro.elizaos.product` (or `ro.elizaos.product`) is set by the AOSP
 * product makefile. White-label forks pick this up automatically as
 * long as their product config sets one of those system properties.
=======
 * `ro.elizaos.product` is set by the AOSP product makefile. White-label
 * forks pick this up automatically because brand markers are appended in
 * addition to the base framework marker, not as replacements.
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
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

import { isAospElizaUserAgent } from "../platform/aosp-user-agent";
import {
  ANDROID_LOCAL_AGENT_API_BASE,
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

<<<<<<< HEAD
/**
 * Pure user-agent test. Exported so unit tests can pin the detection
 * contract without having to mock the whole pre-seed pipeline.
 *
 * MainActivity.applyBrandUserAgentMarkers appends `ElizaOS/<tag>` (or
 * `ElizaOS/<tag>`) only when the corresponding `ro.<brand>os.product`
 * system property is set by the AOSP product makefile. Stock Android
 * leaves the UA untouched, which is exactly when we want to render the
 * picker. The trailing `/` is required — a bare `ElizaOS` token (no
 * version) is malformed and must NOT trigger the pre-seed.
 */
export function isAospElizaUserAgent(
  userAgent: string | null | undefined,
): boolean {
  if (typeof userAgent !== "string" || userAgent.length === 0) return false;
  return /\bElizaOS\/\S/.test(userAgent) || /\bElizaOS\/\S/.test(userAgent);
}

=======
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
function isBrandedAndroidDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return isAospElizaUserAgent(navigator.userAgent);
}

/**
 * No-op when:
 *   - the device is not an AOSP/branded ElizaOS variant (stock Android
 *     installs must always run through `RuntimeGate`'s picker — there
 *     is no on-device agent unless the user opts in),
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
  if (!isBrandedAndroidDevice()) return false;
  if (readPersistedMobileRuntimeMode() != null) return false;
  if (hasPersistedActiveServer()) return false;

  persistMobileRuntimeModeForServerTarget("local");
  writeLocalAgentActiveServer();
  return true;
}
