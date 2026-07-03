/**
 * Side-effect entry point — registers the Phone Companion page with the app
 * shell's in-process page registry.
 *
 * The plugin manifest's `app.navTabs` declaration carries a `componentExport`
 * specifier as a fallback for hosts that don't side-effect-import this file,
 * while this registry entry keeps startup metadata lightweight and loads the
 * companion surface only when the route is activated.
 *
 * Load this module once during app startup to register the page.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "phone-companion",
  pluginId: "@elizaos/plugin-phone",
  label: "Phone Companion",
  icon: "Smartphone",
  path: "/phone-companion",
  tabAffinity: "phone-companion",
  loader: () =>
    import("./companion/components/PhoneCompanionApp").then((module) => ({
      default: module.PhoneCompanionApp,
    })),
});
