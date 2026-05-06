/**
 * Android-only overlay-app runtime plugin registration.
 *
 * This file is only a mobile bundle escape hatch: it imports the runtime
 * plugin subpaths from the owning app packages, applies the agent-side hosted
 * app session gate, and pins those modules into STATIC_ELIZA_PLUGINS for the
 * custom AOSP bundle. The action/provider implementations live in
 * `plugins/app-{wifi,contacts,phone}` so desktop/server builds do not carry
 * duplicate Android stubs here.
 */

import {
  contactsProvider,
  appContactsPlugin as rawContactsPlugin,
} from "@elizaos/app-contacts/plugin";
// Import named providers/actions from their dedicated subpath exports.
// Importing them via `@elizaos/app-phone/plugin` works at runtime but trips
// tsc TS2614 in the JS-tarball build because the dist/plugin.js is built by
// tsup without dts emit, and tsc reads only the value-typing of the default
// export when the dist .js is on disk alongside the .ts. Use dedicated
// subpath exports so each value is resolved against its own .ts file.
import { placeCallAction } from "@elizaos/app-phone/actions/place-call";
import { phoneCallLogProvider } from "@elizaos/app-phone/providers/call-log";
import { appPhonePlugin as rawPhonePlugin } from "@elizaos/app-phone/plugin";
import { appWifiPlugin as rawWifiPlugin } from "@elizaos/app-wifi/plugin";
import { wifiNetworksProvider } from "@elizaos/app-wifi/providers/networks";
import { gatePluginSessionForHostedApp } from "../services/app-session-gate.js";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.js";

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
// the runtime resolves plugins by name. This Android-only bridge must import
// `/plugin` subpaths rather than public UI entries; those public entries pull
// React/app-core surfaces intended for renderer bundles, not the agent runtime.
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
