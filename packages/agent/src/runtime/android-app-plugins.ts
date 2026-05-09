/**
 * Android-only overlay-app runtime plugin registration.
 *
 * This file is only a mobile bundle escape hatch: it imports the runtime
 * owning app package barrels, applies the agent-side hosted app session gate,
 * and pins those modules into STATIC_ELIZA_PLUGINS for the custom AOSP bundle.
 * The action/provider implementations live in `plugins/app-{wifi,contacts,phone}`
 * so desktop/server builds do not carry duplicate Android stubs here.
 */

import {
  contactsProvider,
  appContactsPlugin as rawContactsPlugin,
} from "@elizaos/app-contacts";
import {
  phoneCallLogProvider,
  placeCallAction,
  appPhonePlugin as rawPhonePlugin,
} from "@elizaos/app-phone";
import {
  appWifiPlugin as rawWifiPlugin,
  wifiNetworksProvider,
} from "@elizaos/app-wifi";
import { gatePluginSessionForHostedApp } from "../services/app-session-gate.ts";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.ts";

const WIFI_APP_NAME = "@elizaos/app-wifi";
const CONTACTS_APP_NAME = "@elizaos/app-contacts";
const PHONE_APP_NAME = "@elizaos/app-phone";

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
  placeCallAction,
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
