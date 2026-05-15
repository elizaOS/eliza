import { gatePluginSessionForHostedApp } from "../services/app-session-gate.ts";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.ts";

const WIFI_APP_NAME = "@elizaos/app-wifi";
const CONTACTS_APP_NAME = "@elizaos/app-contacts";
const PHONE_APP_NAME = "@elizaos/app-phone";

const [
  { contactsProvider, appContactsPlugin: rawContactsPlugin },
  { phoneCallLogProvider, appPhonePlugin: rawPhonePlugin },
  { appWifiPlugin: rawWifiPlugin, wifiNetworksProvider },
] = await Promise.all([
  import("@elizaos/app-contacts"),
  import("@elizaos/app-phone"),
  import("@elizaos/app-wifi"),
]);

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
  wifiNetworksProvider,
};
const appContactsPluginModule = {
  default: appContactsPlugin,
  appContactsPlugin,
  contactsProvider,
};
const appPhonePluginModule = {
  default: appPhonePlugin,
  appPhonePlugin,
  phoneCallLogProvider,
};

Object.assign(STATIC_ELIZA_PLUGINS, {
  [WIFI_APP_NAME]: appWifiPluginModule,
  [CONTACTS_APP_NAME]: appContactsPluginModule,
  [PHONE_APP_NAME]: appPhonePluginModule,
});

// Pin to globalThis so Bun.build's tree-shaker keeps the symbols even though
// the runtime resolves plugins by name.
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
