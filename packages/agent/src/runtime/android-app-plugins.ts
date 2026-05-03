/**
 * Android-only overlay-app runtime plugins.
 *
 * The overlay UI packages (`@elizaos/app-wifi`, `@elizaos/app-contacts`,
 * `@elizaos/app-phone`) depend on app-core, which depends back on the agent.
 * Keeping these runtime actions in the agent-side adapter avoids that package
 * cycle while still registering the canonical app plugin names for Android
 * mobile bundles.
 */

import { Contacts } from "@elizaos/capacitor-contacts";
import { Phone } from "@elizaos/capacitor-phone";
import { WiFi } from "@elizaos/capacitor-wifi";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
} from "@elizaos/core";
import { hasRoleAccess } from "@elizaos/shared/eliza-core-roles";
import { gatePluginSessionForHostedApp } from "../services/app-session-gate.js";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.js";

const WIFI_APP_NAME = "@elizaos/app-wifi";
const CONTACTS_APP_NAME = "@elizaos/app-contacts";
const PHONE_APP_NAME = "@elizaos/app-phone";

const DEFAULT_WIFI_LIMIT = 25;
const MAX_WIFI_LIMIT = 100;
const DEFAULT_CONTACTS_LIMIT = 25;
const MAX_CONTACTS_LIMIT = 200;
const DEFAULT_CALL_LOG_LIMIT = 50;
const MAX_CALL_LOG_LIMIT = 50;

interface ScanWifiParams {
  limit?: number;
  maxAge?: number;
}

interface ListContactsParams {
  limit?: number;
}

interface PlaceCallParams {
  phoneNumber?: string;
}

interface ReadCallLogParams {
  limit?: number;
}

function normalizeNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const leadingPlus = trimmed.startsWith("+") ? "+" : "";
  return `${leadingPlus}${trimmed.replace(/[^0-9]/g, "")}`;
}

export const scanWifiAction: Action = {
  name: "SCAN_WIFI",
  similes: ["LIST_WIFI", "WIFI_SCAN", "NEARBY_WIFI", "WIFI_NETWORKS"],
  description:
    "List nearby Wi-Fi networks visible to the device. Returns SSID, BSSID, " +
    "RSSI (signal strength), channel frequency, and whether the network is " +
    "secured. Triggers a fresh scan when the cached results are older than " +
    "`maxAge` milliseconds (default 30000). Requires the WiFi app session " +
    "to be active and ACCESS_FINE_LOCATION granted on device.",
  descriptionCompressed: "List nearby Wi-Fi networks (Android scanResults).",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!(await hasRoleAccess(runtime, message, "USER"))) return false;
    return true;
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ScanWifiParams
      | undefined;
    const requested =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.floor(params.limit)
        : DEFAULT_WIFI_LIMIT;
    const limit = Math.max(1, Math.min(MAX_WIFI_LIMIT, requested));
    const maxAge =
      typeof params?.maxAge === "number" && Number.isFinite(params.maxAge)
        ? Math.max(0, Math.floor(params.maxAge))
        : undefined;

    const { networks } = await WiFi.listAvailableNetworks({ limit, maxAge });

    return {
      text: `Found ${networks.length} Wi-Fi network${networks.length === 1 ? "" : "s"}.`,
      success: true,
      data: { networks, limit },
    };
  },

  parameters: [
    {
      name: "limit",
      description:
        "Maximum number of networks to return (1-100). Defaults to 25.",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 1,
        maximum: MAX_WIFI_LIMIT,
        default: DEFAULT_WIFI_LIMIT,
      },
    },
    {
      name: "maxAge",
      description:
        "Reuse cached scan results if completed within this many milliseconds. " +
        "Defaults to 30000 (30 seconds). Set to 0 to force a fresh scan.",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 0,
      },
    },
  ],
};

export const listContactsAction: Action = {
  name: "LIST_CONTACTS",
  similes: ["GET_CONTACTS", "SHOW_CONTACTS", "READ_CONTACTS"],
  description:
    "List names from the device address book. Android-only. Returns the display names of up to `limit` contacts (default 25).",
  descriptionCompressed: "List contact names from the device address book.",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return hasRoleAccess(runtime, message, "USER");
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ListContactsParams
      | undefined;

    const requested = Number.isFinite(params?.limit)
      ? Number(params?.limit)
      : DEFAULT_CONTACTS_LIMIT;
    const limit = Math.max(
      1,
      Math.min(MAX_CONTACTS_LIMIT, Math.trunc(requested)),
    );

    const { contacts } = await Contacts.listContacts({ limit });
    const names = contacts
      .map((contact) => contact.displayName)
      .filter((name) => name.length > 0);

    return {
      text: names.length === 0 ? "No contacts found." : names.join(", "),
      success: true,
      data: { count: names.length, names },
    };
  },

  parameters: [
    {
      name: "limit",
      description: "Maximum number of contacts to return (1-200).",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 1,
        maximum: MAX_CONTACTS_LIMIT,
        default: DEFAULT_CONTACTS_LIMIT,
      },
    },
  ],
};

export const placeCallAction: Action = {
  name: "PLACE_CALL",
  similes: ["CALL", "DIAL", "RING", "PHONE_CALL", "MAKE_CALL"],
  description:
    "Place a phone call to a given number using the Android Telecom service. " +
    "Requires the Phone app session to be active and the host device to have " +
    "granted the CALL_PHONE runtime permission. The number is dialled directly " +
    "via TelecomManager.placeCall — there is no confirmation step. Pass an " +
    "E.164 or local number string in `phoneNumber`.",
  descriptionCompressed:
    "Place a phone call via Android Telecom. Requires CALL_PHONE permission.",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!(await hasRoleAccess(runtime, message, "USER"))) return false;
    return true;
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | PlaceCallParams
      | undefined;
    const raw = params?.phoneNumber;
    if (typeof raw !== "string") {
      return { text: "phoneNumber is required", success: false };
    }
    const number = normalizeNumber(raw);
    if (!number) {
      return { text: "phoneNumber is required", success: false };
    }

    await Phone.placeCall({ number });

    return {
      text: `Calling ${number}.`,
      success: true,
      data: { phoneNumber: number },
    };
  },

  parameters: [
    {
      name: "phoneNumber",
      description:
        "Phone number to call. Accepts E.164 (`+15551234567`) or local " +
        "formats; non-digit separators (spaces, dashes, parentheses) are " +
        "stripped before dialling.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};

export const readCallLogAction: Action = {
  name: "READ_CALL_LOG",
  similes: ["RECENT_CALLS", "CALL_HISTORY", "LIST_CALLS"],
  description:
    "List the most recent phone calls from the Android call log. Returns up " +
    "to 50 entries (default and maximum), each including number, cached " +
    "contact name, timestamp, duration, and call type (incoming, outgoing, " +
    "missed, voicemail, rejected, blocked, answered_externally). Requires " +
    "the READ_CALL_LOG runtime permission to be granted on device.",
  descriptionCompressed: "List recent Android phone calls (max 50).",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!(await hasRoleAccess(runtime, message, "USER"))) return false;
    return true;
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ReadCallLogParams
      | undefined;
    const requested =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.floor(params.limit)
        : DEFAULT_CALL_LOG_LIMIT;
    const limit = Math.max(1, Math.min(MAX_CALL_LOG_LIMIT, requested));

    const { calls } = await Phone.listRecentCalls({ limit });

    return {
      text: `Found ${calls.length} recent call${calls.length === 1 ? "" : "s"}.`,
      success: true,
      data: { calls, limit },
    };
  },

  parameters: [
    {
      name: "limit",
      description:
        "Maximum number of call log entries to return (1-50). Defaults to 50.",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 1,
        maximum: MAX_CALL_LOG_LIMIT,
        default: DEFAULT_CALL_LOG_LIMIT,
      },
    },
  ],
};

export const rawWifiPlugin: Plugin = {
  name: WIFI_APP_NAME,
  description:
    "WiFi overlay: list nearby networks via Android WifiManager. Actions apply only while the WiFi app session is active.",
  actions: [scanWifiAction],
};

export const rawContactsPlugin: Plugin = {
  name: CONTACTS_APP_NAME,
  description:
    "Contacts overlay: read the device address book via the @elizaos/capacitor-contacts native plugin. Actions apply only while the Contacts app session is active.",
  actions: [listContactsAction],
};

export const rawPhonePlugin: Plugin = {
  name: PHONE_APP_NAME,
  description:
    "Phone overlay: Android dialer, recent-calls, and contact-driven calls. Actions apply only while the Phone app session is active.",
  actions: [placeCallAction, readCallLogAction],
};

export const appWifiPlugin = gatePluginSessionForHostedApp(
  rawWifiPlugin,
  WIFI_APP_NAME,
);
export const appContactsPlugin = gatePluginSessionForHostedApp(
  rawContactsPlugin,
  CONTACTS_APP_NAME,
);
export const appPhonePlugin = gatePluginSessionForHostedApp(
  rawPhonePlugin,
  PHONE_APP_NAME,
);

const appWifiPluginModule = {
  default: appWifiPlugin,
  appWifiPlugin,
  scanWifiAction,
};
const appContactsPluginModule = {
  default: appContactsPlugin,
  appContactsPlugin,
  listContactsAction,
};
const appPhonePluginModule = {
  default: appPhonePlugin,
  appPhonePlugin,
  placeCallAction,
  readCallLogAction,
};

Object.assign(STATIC_ELIZA_PLUGINS, {
  [WIFI_APP_NAME]: appWifiPluginModule,
  [CONTACTS_APP_NAME]: appContactsPluginModule,
  [PHONE_APP_NAME]: appPhonePluginModule,
});

// Pin to globalThis so Bun.build's tree-shaker keeps the symbols even
// though nothing else in this entry references them. Mirrors the
// pattern used for `registerAospLlamaLoader` in `bin.ts`.
(
  globalThis as {
    __elizaAndroidAppPlugins?: {
      wifi: typeof appWifiPluginModule;
      contacts: typeof appContactsPluginModule;
      phone: typeof appPhonePluginModule;
    };
  }
).__elizaAndroidAppPlugins = {
  wifi: appWifiPluginModule,
  contacts: appContactsPluginModule,
  phone: appPhonePluginModule,
};
