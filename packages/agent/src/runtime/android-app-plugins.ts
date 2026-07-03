import { gatePluginSessionForHostedApp } from "../services/app-session-gate.ts";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.ts";

const WIFI_APP_NAME = "@elizaos/plugin-wifi";
const CONTACTS_APP_NAME = "@elizaos/plugin-contacts";
const PHONE_APP_NAME = "@elizaos/plugin-phone";

const [
  { contactsProvider, appContactsPlugin: rawContactsPlugin },
  { phoneCallLogProvider, appPhonePlugin: rawPhonePlugin },
  { appWifiPlugin: rawWifiPlugin, wifiNetworksProvider },
] = await Promise.all([
  import(/* @vite-ignore */ "@elizaos/plugin-contacts"),
  import(/* @vite-ignore */ "@elizaos/plugin-phone"),
  import(/* @vite-ignore */ "@elizaos/plugin-wifi"),
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

// The Object.assign into STATIC_ELIZA_PLUGINS is a consumed side effect that
// Bun.build keeps, so the three app-plugin modules survive tree-shaking without
// any globalThis pinning. The runtime resolves them by name from this registry.
Object.assign(STATIC_ELIZA_PLUGINS, {
  [WIFI_APP_NAME]: appWifiPluginModule,
  [CONTACTS_APP_NAME]: appContactsPluginModule,
  [PHONE_APP_NAME]: appPhonePluginModule,
});
