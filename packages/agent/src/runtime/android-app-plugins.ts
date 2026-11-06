/**
 * Android app-plugin registration. Eagerly imports the wifi/contacts/phone app
 * plugins, wraps each in the hosted-app session gate, and registers them (with
 * their providers) into the STATIC_ELIZA_PLUGINS registry so the mobile runtime
 * resolves them by name.
 */
import { gatePluginSessionForHostedApp } from "../services/app-session-gate.ts";
import { ANDROID_APP_PLUGIN_NAMES } from "./android-app-plugin-loaders.ts";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.ts";

const [WIFI_APP_NAME, CONTACTS_APP_NAME, PHONE_APP_NAME] =
  ANDROID_APP_PLUGIN_NAMES;

const [
  { contactsProvider, appContactsPlugin: rawContactsPlugin },
  { phoneCallLogProvider, appPhonePlugin: rawPhonePlugin },
  { appWifiPlugin: rawWifiPlugin, wifiNetworksProvider },
] = await Promise.all([
  import(/* @vite-ignore */ "@elizaos/plugin-native-contacts/plugin"),
  import(/* @vite-ignore */ "@elizaos/plugin-native-phone/plugin"),
  import(/* @vite-ignore */ "@elizaos/plugin-native-wifi/plugin"),
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
