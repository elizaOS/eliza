/**
 * Static imports for Android-only overlay-app runtime plugins
 * (@elizaos/app-wifi, @elizaos/app-contacts, @elizaos/app-phone).
 *
 * Why a separate file: each app's plugin module imports
 * `gatePluginSessionForHostedApp` from `@elizaos/agent`, whose barrel
 * re-exports `runtime/eliza.ts`. A top-level static import inside
 * `eliza.ts` would form a module-init cycle — eliza.ts → app plugin →
 * @elizaos/agent → eliza.ts, with the app plugin seeing undefined
 * named exports.
 *
 * Loading these via this file imported AFTER eliza.ts (from `bin.ts`)
 * sidesteps the cycle: by the time this file evaluates, eliza.ts has
 * fully populated its exports, so the app plugins resolve their
 * `gatePluginSessionForHostedApp` import cleanly.
 *
 * Registration with `STATIC_ELIZA_PLUGINS` lets `plugin-resolver.ts`
 * pick the bundled module up first instead of falling through to a
 * dynamic `import` of the `/plugin` subpath — which, on Android, has
 * no `node_modules` to resolve against and would fail with
 * `ResolveMessage: Cannot find module`.
 */

import * as appWifiPlugin from "@elizaos/app-wifi/plugin";
import * as appContactsPlugin from "@elizaos/app-contacts/plugin";
import * as appPhonePlugin from "@elizaos/app-phone/plugin";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.js";

Object.assign(STATIC_ELIZA_PLUGINS, {
  "@elizaos/app-wifi": appWifiPlugin,
  "@elizaos/app-contacts": appContactsPlugin,
  "@elizaos/app-phone": appPhonePlugin,
});

// Pin to globalThis so Bun.build's tree-shaker keeps the symbols even
// though nothing else in this entry references them. Mirrors the
// pattern used for `registerAospLlamaLoader` in `bin.ts`.
(
  globalThis as {
    __miladyAndroidAppPlugins?: {
      wifi: typeof appWifiPlugin;
      contacts: typeof appContactsPlugin;
      phone: typeof appPhonePlugin;
    };
  }
).__miladyAndroidAppPlugins = {
  wifi: appWifiPlugin,
  contacts: appContactsPlugin,
  phone: appPhonePlugin,
};
