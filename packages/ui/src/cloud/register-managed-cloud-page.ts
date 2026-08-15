/**
 * Registers the unified Cloud management route family as one lazy page in the
 * Eliza app shell. `/cloud` is the single management route family; the web
 * router separately redirects retired `/dashboard/*` bookmarks into it.
 */

import { registerAppShellPage } from "../app-shell-registry";

let managedCloudPageRegistered = false;

export function registerManagedCloudAppShellPage(): void {
  if (managedCloudPageRegistered) return;
  managedCloudPageRegistered = true;
  registerAppShellPage({
    id: "cloud",
    pluginId: "@elizaos/ui",
    label: "Cloud",
    icon: "Cloud",
    path: "/cloud",
    pathPatterns: ["/cloud/*"],
    availability: "managed-cloud",
    viewKind: "release",
    loader: () =>
      import("./shell/ManagedCloudPage").then((module) => ({
        default: module.default,
      })),
  });
}
