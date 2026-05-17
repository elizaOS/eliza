/**
 * Network-policy bridge — used by the voice-model auto-updater and the
 * model downloader to decide whether a multi-GB pull is allowed to proceed
 * without prompting the user.
 *
 * Per R5-versioning §4 (per-platform download policy):
 *
 * - Android: `NetworkCapabilities.hasCapability(NET_CAPABILITY_NOT_METERED)`.
 *   Android explicitly warns against equating cellular = metered (a user
 *   can have unmetered cellular, or a metered Wi-Fi hotspot), so the
 *   metered flag is mandatory, not derived from connection type.
 * - iOS: `NWPathMonitor.path.isExpensive` — Apple's "treat as metered" flag.
 * - Desktop (Electron/Electrobun): WinRT `NetworkCostType`, NetworkManager
 *   dbus `ActiveConnection.Metered`, or macOS `NWPathMonitor` via the
 *   native bridge.
 * - Headless server / CLI: skip auto-update entirely; explicit
 *   `milady models update` only.
 *
 * The actual platform shims are wired in `plugin-local-inference`'s
 * `services/network-policy.ts`. This module defines the platform-agnostic
 * decision contract and ships a stub `evaluateNetworkPolicy` that lets
 * higher-level code unit-test the decision rule without a runtime.
 */

/**
 * Five canonical network classes. Platform-specific connection types
 * collapse into one of these. `unknown` is reserved for platforms where
 * the OS does not expose enough information to disambiguate; the policy
 * decision for `unknown` is intentionally platform-specific (see
 * `applyNetworkPolicy`).
 */
export type NetworkClass =
  | "wifi-unmetered"
  | "wifi-metered"
  | "ethernet-unmetered"
  | "ethernet-metered"
  | "cellular"
  | "unknown";

/**
 * Reason the policy reached its `allow` decision. Distinguishes the three
 * dialogs the UI may need to show.
 */
export type NetworkPolicyReason =
  | "auto"
  | "metered-ask"
  | "cellular-ask"
  | "headless-explicit-only";

export interface NetworkPolicyDecision {
  readonly class: NetworkClass;
  /** Whether the download may proceed without prompting the user. */
  readonly allow: boolean;
  /** When `allow === false`, the UI must show a confirm dialog. */
  readonly reason: NetworkPolicyReason;
  /** Estimated bytes to transfer — used in the confirm dialog. */
  readonly estimatedBytes: number;
}

/**
 * User-facing toggles that override the default policy. Persisted in
 * `milady.json` via `voiceUpdatePolicy`. The cellular toggle is OWNER-only
 * (D6 / R5-versioning §5.4).
 */
export interface NetworkPolicyPreferences {
  /** Auto-update on Wi-Fi when unmetered. Default: true. */
  readonly autoUpdateOnWifi: boolean;
  /** Auto-update on cellular. OWNER-only toggle. Default: false. */
  readonly autoUpdateOnCellular: boolean;
  /** Auto-update on any metered link. Default: false. */
  readonly autoUpdateOnMetered: boolean;
  /**
   * Quiet hours when auto-update is suppressed. Local clock. Empty array
   * = no quiet hours. Each entry is `{ start: "HH:MM", end: "HH:MM" }`,
   * inclusive of `start`, exclusive of `end`. Crossing midnight is
   * permitted (`{ start: "22:00", end: "08:00" }`).
   */
  readonly quietHours: ReadonlyArray<{ start: string; end: string }>;
}

export const DEFAULT_NETWORK_POLICY_PREFERENCES: NetworkPolicyPreferences = {
  autoUpdateOnWifi: true,
  autoUpdateOnCellular: false,
  autoUpdateOnMetered: false,
  quietHours: [{ start: "22:00", end: "08:00" }],
};

/**
 * Raw network state as reported by the platform shim. Producers fill in
 * what they know; the decision rule treats absent fields as "unknown".
 */
export interface RawNetworkState {
  readonly connectionType:
    | "wifi"
    | "ethernet"
    | "cellular"
    | "none"
    | "unknown";
  /**
   * True when the OS reports the link as metered. On Android this maps to
   * `!NET_CAPABILITY_NOT_METERED`; on iOS to `path.isExpensive`; on
   * Windows to `NetworkCostType.{Fixed,Variable}`; on Linux to
   * NetworkManager's `Metered: yes`.
   */
  readonly metered: boolean | null;
}

/** Classify the raw state into one of the five canonical classes. */
export function classifyNetwork(state: RawNetworkState): NetworkClass {
  if (state.connectionType === "none") return "unknown";
  if (state.connectionType === "cellular") return "cellular";
  if (state.connectionType === "wifi") {
    if (state.metered === true) return "wifi-metered";
    if (state.metered === false) return "wifi-unmetered";
    return "unknown";
  }
  if (state.connectionType === "ethernet") {
    if (state.metered === true) return "ethernet-metered";
    if (state.metered === false) return "ethernet-unmetered";
    return "unknown";
  }
  return "unknown";
}

/**
 * Apply the user prefs + estimated transfer size to a classified network
 * state. The decision rule:
 *
 * - cellular: ask unless `autoUpdateOnCellular === true`.
 * - any `*-metered`: ask unless `autoUpdateOnMetered === true`.
 * - `wifi-unmetered`: auto if `autoUpdateOnWifi === true`, else ask.
 * - `ethernet-unmetered`: always auto (desktop wired link).
 * - `unknown`: ask (mobile default; desktop callers can override).
 *
 * Quiet hours (if active) downgrade all `auto` decisions to `ask`.
 */
export function applyNetworkPolicy(
  klass: NetworkClass,
  prefs: NetworkPolicyPreferences,
  estimatedBytes: number,
  options?: { now?: Date; isHeadless?: boolean },
): NetworkPolicyDecision {
  if (options?.isHeadless === true) {
    return {
      class: klass,
      allow: false,
      reason: "headless-explicit-only",
      estimatedBytes,
    };
  }
  const reasonForAsk = (): NetworkPolicyReason => {
    if (klass === "cellular") return "cellular-ask";
    if (klass === "wifi-metered" || klass === "ethernet-metered") {
      return "metered-ask";
    }
    return "metered-ask";
  };

  let autoAllowed: boolean;
  switch (klass) {
    case "ethernet-unmetered":
      autoAllowed = true;
      break;
    case "wifi-unmetered":
      autoAllowed = prefs.autoUpdateOnWifi;
      break;
    case "wifi-metered":
    case "ethernet-metered":
      autoAllowed = prefs.autoUpdateOnMetered;
      break;
    case "cellular":
      autoAllowed = prefs.autoUpdateOnCellular;
      break;
    case "unknown":
      autoAllowed = false;
      break;
  }

  if (
    autoAllowed &&
    inQuietHours(prefs.quietHours, options?.now ?? new Date())
  ) {
    autoAllowed = false;
  }

  return {
    class: klass,
    allow: autoAllowed,
    reason: autoAllowed ? "auto" : reasonForAsk(),
    estimatedBytes,
  };
}

function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** True if `now` falls inside any quiet-hours window. */
export function inQuietHours(
  windows: ReadonlyArray<{ start: string; end: string }>,
  now: Date,
): boolean {
  if (windows.length === 0) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const start = parseClock(w.start);
    const end = parseClock(w.end);
    if (start === null || end === null) continue;
    if (start === end) continue;
    if (start < end) {
      if (minutes >= start && minutes < end) return true;
    } else {
      // Window crosses midnight: e.g. 22:00 -> 08:00.
      if (minutes >= start || minutes < end) return true;
    }
  }
  return false;
}

/**
 * Convenience composition for callers that have a raw state + prefs +
 * estimated size in hand and want a single decision.
 */
export function evaluateNetworkPolicy(
  state: RawNetworkState,
  prefs: NetworkPolicyPreferences,
  estimatedBytes: number,
  options?: { now?: Date; isHeadless?: boolean },
): NetworkPolicyDecision {
  return applyNetworkPolicy(
    classifyNetwork(state),
    prefs,
    estimatedBytes,
    options,
  );
}
