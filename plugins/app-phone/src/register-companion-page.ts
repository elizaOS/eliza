/**
 * Side-effect entry point — registers the Phone Companion page with the app
 * shell's in-process page registry so it mounts without a dynamic import.
 *
 * The plugin manifest's `app.navTabs` declaration carries a `componentExport`
 * specifier as a fallback for hosts that don't side-effect-import this file,
 * but bundling the component directly avoids the lazy-load placeholder.
 *
 * Load this module once during app startup to register the page.
 */

import { registerAppShellPage } from "@elizaos/ui";
import { PhoneCompanionApp } from "./companion/components/PhoneCompanionApp";

registerAppShellPage({
  id: "phone-companion",
  pluginId: "@elizaos/app-phone",
  label: "Phone Companion",
  icon: "Smartphone",
  path: "/phone-companion",
  Component: PhoneCompanionApp,
});
