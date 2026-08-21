/**
 * Registers the unified Cloud management route family as one lazy page in the
 * Eliza app shell. `/cloud` is the single management route family; the web
 * router separately redirects retired `/dashboard/*` bookmarks into it. The
 * page owns a nested React Router route family, so its surface manifest grants
 * navigation while leaving storage and wallpaper authority default-denied.
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
    surface: { capabilities: ["navigate"] },
    loader: () =>
      import("./shell/ManagedCloudPage").then((module) => ({
        default: module.default,
      })),
  });
}
