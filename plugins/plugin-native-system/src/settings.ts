/**
 * Truthful presentation of Android system facts for settings surfaces and quick-setting tiles.
 *
 * Browser-safe and dependency-free. Only facts Android reported become an on/off state; a fact it
 * did not report reads as a handoff ("Open settings"), never as off. Every switch except the
 * flashlight is read-only for an ordinary app, so a tile or row hands off to Android's own page
 * and is announced as a button carrying the reported state, not as a toggle.
 */
import type {
  AndroidRoleName,
  AndroidRoleStatus,
  SystemFacts,
  SystemSettingsPage,
  SystemSettingsPageResult,
} from "./definitions";

/** Quick-setting keys a settings surface can present. */
export type SystemTileKey =
  | "wifi"
  | "bt"
  | "dnd"
  | "mic"
  | "loc"
  | "plane"
  | "torch";

/** Only directly observed native facts. A missing key means unknown: no on/off is shown. */
export type SystemTileFacts = Partial<Record<SystemTileKey, boolean>>;

/** Android page each handoff tile opens. The flashlight is a direct control and has none. */
export const SYSTEM_TILE_SETTINGS_PAGES: Readonly<
  Partial<Record<SystemTileKey, SystemSettingsPage>>
> = Object.freeze({
  wifi: "wifi",
  bt: "bluetooth",
  dnd: "dnd",
  plane: "airplane",
  loc: "location",
  mic: "privacy",
});

const BOOLEAN_FACTS = [
  "wifiEnabled",
  "bluetoothEnabled",
  "airplaneMode",
  "locationEnabled",
  "mobileDataEnabled",
  "adaptiveBrightness",
  "wifiActive",
  "cellularActive",
  "internetValidated",
  "charging",
  "powerSave",
] as const;
const INTERRUPTION_FILTERS = new Set(["all", "priority", "alarms", "none"]);

/**
 * Keeps only well-formed facts from `getSystemFacts()` or a host snapshot carrying the same keys.
 * A wrong type, an unknown filter or an out-of-range battery level is dropped, so it reads as
 * unknown rather than as a state.
 */
export function parseSystemFacts(value: unknown): SystemFacts {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const facts: SystemFacts = {};
  for (const key of BOOLEAN_FACTS)
    if (typeof input[key] === "boolean") facts[key] = input[key] as boolean;
  if (
    typeof input.interruptionFilter === "string" &&
    INTERRUPTION_FILTERS.has(input.interruptionFilter)
  )
    facts.interruptionFilter =
      input.interruptionFilter as SystemFacts["interruptionFilter"];
  if (
    Number.isInteger(input.batteryPercent) &&
    (input.batteryPercent as number) >= 0 &&
    (input.batteryPercent as number) <= 100
  )
    facts.batteryPercent = input.batteryPercent as number;
  return facts;
}

/**
 * Tile state from reported switches. Without the Wi-Fi switch, an active Wi-Fi transport still
 * proves Wi-Fi is on; no active transport does not prove it is off (it may be on and
 * disconnected). Permission grants are not switch states, so the microphone tile never gets one.
 */
export function tileFactsFromSystemFacts(
  snapshot: unknown,
  torch?: boolean,
): SystemTileFacts {
  const facts: SystemTileFacts = {};
  const value =
    snapshot && typeof snapshot === "object"
      ? (snapshot as Record<string, unknown>)
      : {};
  if (typeof value.wifiEnabled === "boolean") facts.wifi = value.wifiEnabled;
  else if (value.wifiActive === true) facts.wifi = true;
  if (typeof value.bluetoothEnabled === "boolean")
    facts.bt = value.bluetoothEnabled;
  if (typeof value.airplaneMode === "boolean") facts.plane = value.airplaneMode;
  if (typeof value.locationEnabled === "boolean")
    facts.loc = value.locationEnabled;
  if (value.interruptionFilter === "all") facts.dnd = false;
  else if (
    value.interruptionFilter === "priority" ||
    value.interruptionFilter === "alarms" ||
    value.interruptionFilter === "none"
  )
    facts.dnd = true;
  if (typeof torch === "boolean") facts.torch = torch;
  return facts;
}

/** Visible state under a tile. An unread switch says what the tile does instead of looking off. */
export function tileStateText(
  key: SystemTileKey | null,
  on: boolean | undefined,
): string {
  if (typeof on === "boolean") return on ? "On" : "Off";
  return key === "torch"
    ? "Tap to switch"
    : key === "mic"
      ? "Permissions"
      : "Open settings";
}

/**
 * Accessible name of a tile. A handoff tile is a button whose name carries the reported state
 * ("Wi-Fi, on, opens Android settings"); the flashlight is the one real toggle and keeps its name.
 */
export function tileAccessibleName(
  label: string,
  key: SystemTileKey | null,
  on: boolean | undefined,
): string {
  if (key === "torch") return label;
  const state = typeof on === "boolean" ? (on ? ", on" : ", off") : "";
  return (
    label +
    state +
    (key === "mic"
      ? ", opens Android permission settings"
      : ", opens Android settings")
  );
}

/** Settings row wording for a system switch: its state when Android reported it, else the fallback. */
export function switchValue(
  on: unknown,
  fallback: string,
  detail?: { on?: string; off?: string },
): string {
  return typeof on === "boolean"
    ? on
      ? (detail?.on ?? "On")
      : (detail?.off ?? "Off")
    : fallback;
}

/** What to say when Android opened a broader page than the one asked for; null for the specific page. */
export function broaderPageNotice(
  page: string,
  opened: unknown,
): string | null {
  if (
    !opened ||
    typeof opened !== "object" ||
    (opened as Partial<SystemSettingsPageResult>).specific !== false
  )
    return null;
  if (page === "airplane" || page === "mobile")
    return "Opened Android network settings. This phone has no separate page for that switch.";
  if (page === "dnd")
    return "Opened Android priority settings. This phone has no separate Do Not Disturb page.";
  return "Opened a related Android settings page. This phone has no separate page for that setting.";
}

/** One settings handoff per gesture: repeated change events inside the window are ignored. */
export function handoffGate(
  windowMs = 2000,
  now: () => number = () => Date.now(),
) {
  let last = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  return {
    begin(): boolean {
      const at = now();
      if (inFlight || at - last < windowMs) return false;
      inFlight = true;
      last = at;
      return true;
    },
    end() {
      inFlight = false;
      last = now();
    },
  };
}

/** One read-only system switch row: its reported state and the Android page that changes it. */
export interface SystemSwitchRow {
  page: SystemSettingsPage;
  label: string;
  value: string;
}

const NOT_REPORTED = "Not reported by Android";
const INTERRUPTION_LABELS: Record<
  NonNullable<SystemFacts["interruptionFilter"]>,
  string
> = {
  all: "Off",
  priority: "Priority only",
  alarms: "Alarms only",
  none: "Total silence",
};

/**
 * Settings rows for the switches an ordinary app can read. A row shows what Android reported and
 * says so when it reported nothing; it never infers off from a missing fact. Each row hands off to
 * its Android page, where the owner changes the switch.
 */
export function systemSwitchRows(value: unknown): SystemSwitchRow[] {
  const facts = parseSystemFacts(value);
  const connectedWifi = facts.wifiActive === true;
  return [
    {
      page: "wifi",
      label: "Wi-Fi",
      value: switchValue(
        facts.wifiEnabled,
        connectedWifi ? "On · connected" : NOT_REPORTED,
        { on: connectedWifi ? "On · connected" : "On" },
      ),
    },
    {
      page: "bluetooth",
      label: "Bluetooth",
      value: switchValue(facts.bluetoothEnabled, NOT_REPORTED),
    },
    {
      page: "mobile",
      label: "Mobile data",
      value:
        facts.airplaneMode === true
          ? "Airplane mode on"
          : switchValue(facts.mobileDataEnabled, NOT_REPORTED, {
              on: facts.cellularActive === true ? "On · in use" : "On",
            }),
    },
    {
      page: "airplane",
      label: "Airplane mode",
      value: switchValue(facts.airplaneMode, NOT_REPORTED),
    },
    {
      page: "location",
      label: "Location",
      value: switchValue(facts.locationEnabled, NOT_REPORTED),
    },
    {
      page: "dnd",
      label: "Do Not Disturb",
      value: facts.interruptionFilter
        ? INTERRUPTION_LABELS[facts.interruptionFilter]
        : NOT_REPORTED,
    },
    {
      page: "battery",
      label: "Battery",
      value:
        typeof facts.batteryPercent === "number"
          ? `${facts.batteryPercent}%${facts.charging === true ? " · charging" : ""}${facts.powerSave === true ? " · battery saver" : ""}`
          : NOT_REPORTED,
    },
  ];
}

const ROLE_NAMES = new Set<AndroidRoleName>([
  "home",
  "dialer",
  "sms",
  "assistant",
]);

/** Role rows exactly as `getStatus()` reported them; malformed rows are dropped, never guessed. */
export function parseRoleStatuses(status: unknown): AndroidRoleStatus[] {
  const rows = (status as { roles?: unknown } | null | undefined)?.roles;
  if (!Array.isArray(rows)) return [];
  const out: AndroidRoleStatus[] = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      !ROLE_NAMES.has((row as AndroidRoleStatus).role) ||
      typeof (row as AndroidRoleStatus).held !== "boolean" ||
      typeof (row as AndroidRoleStatus).available !== "boolean"
    )
      continue;
    const value = row as AndroidRoleStatus;
    out.push({
      role: value.role,
      androidRole:
        typeof value.androidRole === "string" ? value.androidRole : "",
      held: value.held,
      available: value.available,
      holders: Array.isArray(value.holders)
        ? value.holders.filter(
            (holder): holder is string => typeof holder === "string",
          )
        : [],
    });
  }
  return out;
}

/**
 * Truthful role wording. Android answers whether this app holds a role; holder lookups for other
 * apps are best effort (package visibility, Android's own resolver), so an empty or unreadable
 * holder list never claims that no app holds the role.
 */
export function androidRoleLabel(
  role: Pick<AndroidRoleStatus, "available" | "held" | "holders"> | undefined,
  host: { packageName: string; appName: string },
): string {
  if (!role) return "Unavailable";
  if (!role.available) return "Not available on this device";
  if (role.held) return host.appName;
  return role.holders.some(
    (holder) => holder !== "android" && holder !== host.packageName,
  )
    ? "Another app"
    : `Not ${host.appName}`;
}
