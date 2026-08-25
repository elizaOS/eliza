/**
 * Unit tests for Android app-plugin registration. Drives the real
 * `android-app-plugins` module: hosted-app session gating of the wifi /
 * contacts / phone plugins, and the STATIC_ELIZA_PLUGINS Object.assign that
 * the mobile runtime resolves by name.
 *
 * The wifi/contacts barrels call `isElizaOS()` from `./register` at import.
 * That catalog side-effect is not this module's job; the mocks below replace
 * only those register files so the real `/plugin` objects still load.
 */
import type { IAgentRuntime, Plugin, Provider } from "@elizaos/core";
import {
  APP_SESSION_SERVICE_TYPE,
  type AppRunSummary,
  type AppSessionServiceLike,
} from "@elizaos/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../../../plugins/plugin-wifi/src/register.ts", () => ({}));
vi.mock("../../../../plugins/plugin-contacts/src/register.ts", () => ({}));
vi.mock("@elizaos/plugin-wifi/register", () => ({}));
vi.mock("@elizaos/plugin-contacts/register", () => ({}));

import { setOverlayAppPresence } from "../services/overlay-app-presence.ts";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.ts";

const WIFI = "@elizaos/plugin-wifi";
const CONTACTS = "@elizaos/plugin-contacts";
const PHONE = "@elizaos/plugin-phone";
const SENTINEL = "__android-app-plugins-coverage-sentinel__";

const STOPPED_STATUSES = ["stopped", "offline", "error", "failed"] as const;

type AndroidAppPlugins = {
  appWifiPlugin: Plugin;
  appContactsPlugin: Plugin;
  appPhonePlugin: Plugin;
};

type RawPluginModule = {
  appWifiPlugin?: Plugin;
  appContactsPlugin?: Plugin;
  appPhonePlugin?: Plugin;
  wifiNetworksProvider?: Provider;
  contactsProvider?: Provider;
  phoneCallLogProvider?: Provider;
};

let android: AndroidAppPlugins;
let rawWifi: RawPluginModule;
let rawContacts: RawPluginModule;
let rawPhone: RawPluginModule;

function run(appName: string, status: string): AppRunSummary {
  return { appName, status } as AppRunSummary;
}

function makeRuntime(runs: AppRunSummary[] | "absent"): IAgentRuntime {
  const getService = (type: string): AppSessionServiceLike | undefined => {
    if (runs === "absent") return undefined;
    if (type !== APP_SESSION_SERVICE_TYPE) return undefined;
    return { getRuns: () => runs };
  };
  return { getService } as unknown as IAgentRuntime;
}

function registryModule(name: string): Record<string, unknown> {
  const value = STATIC_ELIZA_PLUGINS[name];
  expect(value, `STATIC_ELIZA_PLUGINS[${name}]`).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function requiredPlugin(plugin: Plugin | undefined, label: string): Plugin {
  if (!plugin) {
    throw new Error(`${label} is missing from the /plugin module`);
  }
  return plugin;
}

function firstProvider(plugin: Plugin, label: string): Provider {
  expect(plugin.providers, `${label} providers`).toBeDefined();
  expect(plugin.providers?.length, `${label} provider count`).toBe(1);
  const provider = plugin.providers?.[0];
  if (!provider) {
    throw new Error(`${label} is missing its single provider`);
  }
  return provider;
}

async function providerGet(
  plugin: Plugin,
  runtime: IAgentRuntime,
): Promise<{ text?: string; data?: Record<string, unknown> }> {
  const provider = firstProvider(plugin, plugin.name);
  return provider.get(runtime, {} as never, {} as never);
}

beforeAll(async () => {
  // Seed a pre-existing registry key so Object.assign must MERGE, not replace.
  STATIC_ELIZA_PLUGINS[SENTINEL] = { keep: true };
  // `/plugin` is the ungated plugin object the SUT wraps.
  [rawWifi, rawContacts, rawPhone] = await Promise.all([
    import("@elizaos/plugin-wifi/plugin"),
    import("@elizaos/plugin-contacts/plugin"),
    import("@elizaos/plugin-phone/plugin"),
  ]);
  android = await import("./android-app-plugins.ts");
});

afterEach(() => {
  setOverlayAppPresence(null);
});

afterAll(() => {
  delete STATIC_ELIZA_PLUGINS[SENTINEL];
});

describe("android-app-plugins exports", () => {
  it("exports the three gated plugins under the canonical package names", () => {
    expect(android.appWifiPlugin.name).toBe(WIFI);
    expect(android.appContactsPlugin.name).toBe(CONTACTS);
    expect(android.appPhonePlugin.name).toBe(PHONE);
  });

  it("wraps each raw plugin in a new object rather than exporting the raw reference", () => {
    expect(android.appWifiPlugin).not.toBe(
      requiredPlugin(rawWifi.appWifiPlugin, "wifi"),
    );
    expect(android.appContactsPlugin).not.toBe(
      requiredPlugin(rawContacts.appContactsPlugin, "contacts"),
    );
    expect(android.appPhonePlugin).not.toBe(
      requiredPlugin(rawPhone.appPhonePlugin, "phone"),
    );
  });

  it("preserves identity fields from the raw plugins (spread, not a rename)", () => {
    const wifi = requiredPlugin(rawWifi.appWifiPlugin, "wifi");
    const contacts = requiredPlugin(rawContacts.appContactsPlugin, "contacts");
    const phone = requiredPlugin(rawPhone.appPhonePlugin, "phone");
    expect(android.appWifiPlugin.description).toBe(wifi.description);
    expect(android.appContactsPlugin.description).toBe(contacts.description);
    expect(android.appPhonePlugin.description).toBe(phone.description);
    expect(android.appContactsPlugin.views).toEqual(contacts.views);
    expect(android.appPhonePlugin.views).toEqual(phone.views);
    expect(android.appPhonePlugin.app).toEqual(phone.app);
  });

  it("passes through a missing actions list (wifi / contacts have none)", () => {
    expect(
      requiredPlugin(rawWifi.appWifiPlugin, "wifi").actions,
    ).toBeUndefined();
    expect(
      requiredPlugin(rawContacts.appContactsPlugin, "contacts").actions,
    ).toBeUndefined();
    expect(android.appWifiPlugin.actions).toBeUndefined();
    expect(android.appContactsPlugin.actions).toBeUndefined();
  });

  it("passes through an empty actions queue without wrapping (phone)", () => {
    const phone = requiredPlugin(rawPhone.appPhonePlugin, "phone");
    expect(phone.actions).toEqual([]);
    expect(android.appPhonePlugin.actions).toBe(phone.actions);
    expect(android.appPhonePlugin.actions).toEqual([]);
  });

  it("keeps a single wrapped provider on each plugin", () => {
    const wifi = firstProvider(android.appWifiPlugin, "wifi");
    const contacts = firstProvider(android.appContactsPlugin, "contacts");
    const phone = firstProvider(android.appPhonePlugin, "phone");
    expect(wifi.name).toBe("wifiNetworks");
    expect(contacts.name).toBe("androidContacts");
    expect(phone.name).toBe("phoneCallLog");
  });
});

describe("STATIC_ELIZA_PLUGINS registration", () => {
  it("merges the three app-plugin modules without wiping pre-existing keys", () => {
    expect(STATIC_ELIZA_PLUGINS[SENTINEL]).toEqual({ keep: true });
    expect(STATIC_ELIZA_PLUGINS[WIFI]).toBeDefined();
    expect(STATIC_ELIZA_PLUGINS[CONTACTS]).toBeDefined();
    expect(STATIC_ELIZA_PLUGINS[PHONE]).toBeDefined();
  });

  it("registers wifi with default + named plugin + the ungated provider", () => {
    const mod = registryModule(WIFI);
    expect(mod.default).toBe(android.appWifiPlugin);
    expect(mod.appWifiPlugin).toBe(android.appWifiPlugin);
    expect(mod.wifiNetworksProvider).toBe(rawWifi.wifiNetworksProvider);
  });

  it("registers contacts with default + named plugin + the ungated provider", () => {
    const mod = registryModule(CONTACTS);
    expect(mod.default).toBe(android.appContactsPlugin);
    expect(mod.appContactsPlugin).toBe(android.appContactsPlugin);
    expect(mod.contactsProvider).toBe(rawContacts.contactsProvider);
  });

  it("registers phone with default + named plugin + the ungated provider", () => {
    const mod = registryModule(PHONE);
    expect(mod.default).toBe(android.appPhonePlugin);
    expect(mod.appPhonePlugin).toBe(android.appPhonePlugin);
    expect(mod.phoneCallLogProvider).toBe(rawPhone.phoneCallLogProvider);
  });

  it("does not invent a registry entry for a missing / never-assigned name", () => {
    expect(STATIC_ELIZA_PLUGINS["@elizaos/plugin-native-wifi"]).toBeUndefined();
    expect(STATIC_ELIZA_PLUGINS[""]).toBeUndefined();
  });

  it("keeps the named registry provider ungated while the plugin provider is wrapped", () => {
    const gated = firstProvider(android.appWifiPlugin, "gated wifi");
    const raw = firstProvider(
      requiredPlugin(rawWifi.appWifiPlugin, "wifi"),
      "raw wifi",
    );
    expect(gated).not.toBe(raw);
    expect(gated.get).not.toBe(raw.get);
    expect(gated.name).toBe(raw.name);
  });
});

describe("hosted-app session gate wrapping", () => {
  it("blocks every provider when the app-session service is absent (empty runtime)", async () => {
    const runtime = makeRuntime("absent");
    for (const plugin of [
      android.appWifiPlugin,
      android.appContactsPlugin,
      android.appPhonePlugin,
    ]) {
      const result = await providerGet(plugin, runtime);
      expect(result.text).toBe("");
      expect(result.data).toMatchObject({
        available: false,
        appSessionInactive: true,
      });
    }
  });

  it("blocks when the run queue is empty", async () => {
    const result = await providerGet(android.appWifiPlugin, makeRuntime([]));
    expect(result.data).toMatchObject({ appSessionInactive: true });
  });

  it("blocks a single foreign running app (wrong canonical name)", async () => {
    const result = await providerGet(
      android.appWifiPlugin,
      makeRuntime([run(PHONE, "running")]),
    );
    expect(result.data).toMatchObject({ appSessionInactive: true });
  });

  it("blocks every stopped-class status, including mixed case and padding", async () => {
    for (const status of STOPPED_STATUSES) {
      const result = await providerGet(
        android.appWifiPlugin,
        makeRuntime([run(WIFI, status)]),
      );
      expect(result.data, status).toMatchObject({ appSessionInactive: true });
    }

    const mixed = await providerGet(
      android.appWifiPlugin,
      makeRuntime([run(WIFI, "  STOPPED  ")]),
    );
    expect(mixed.data).toMatchObject({ appSessionInactive: true });
  });

  it("does not open wifi when contacts is the only active run (independent gates)", async () => {
    const runtime = makeRuntime([run(CONTACTS, "running")]);
    const wifi = await providerGet(android.appWifiPlugin, runtime);
    const contacts = await providerGet(android.appContactsPlugin, runtime);
    expect(wifi.data).toMatchObject({ appSessionInactive: true });
    expect(contacts.data).not.toMatchObject({ appSessionInactive: true });
  });

  it("passes through to the real provider when a matching run is active", async () => {
    const result = await providerGet(
      android.appWifiPlugin,
      makeRuntime([run(WIFI, "running")]),
    );
    expect(result.data).not.toMatchObject({ appSessionInactive: true });
    expect(result.data).toBeTypeOf("object");
  });

  it("treats a matching run with empty status as active (not in the stopped set)", async () => {
    const result = await providerGet(
      android.appContactsPlugin,
      makeRuntime([run(CONTACTS, "")]),
    );
    expect(result.data).not.toMatchObject({ appSessionInactive: true });
  });

  it("opens the gate from overlay presence without an AppManager run", async () => {
    setOverlayAppPresence(WIFI);
    const result = await providerGet(android.appWifiPlugin, makeRuntime([]));
    expect(result.data).not.toMatchObject({ appSessionInactive: true });
  });

  it("does not open a different plugin from a foreign overlay heartbeat", async () => {
    setOverlayAppPresence(PHONE);
    const result = await providerGet(android.appWifiPlugin, makeRuntime([]));
    expect(result.data).toMatchObject({ appSessionInactive: true });
  });
});
