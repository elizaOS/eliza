/**
 * In-process app-shell registration for the Eliza Cloud **Applications**
 * dashboard across web and native runtimes.
 *
 * The web build keeps this route inside the tab/view `App`, where the shared
 * navigate-view listener remains mounted while Cloud Apps is active. Its
 * `WebAppsStudio` inherits the top-level cloud providers. Native runtimes use
 * the self-contained `NativeAppsStudio` with its own router and providers.
 *
 * This uses the in-process app-shell registration mechanism (the same one
 * `orchestrator` / `wallet.inventory` use). The platform-specific import stays
 * **lazy** so the studio chunk and its Applications domain load only when the
 * studio is opened.
 *
 * The page id is `cloud-apps` (the local installed-`AppsView` owns `apps`), the
 * route is `/cloud-apps`, and the label is "Cloud Apps". The page is NOT a
 * launcher tile: Projects is the one apps destination in the launcher
 * (`LAUNCHER_HIDDEN_IDS` in `@elizaos/ui`'s launcher-curation), and this route
 * is reached from the Projects view's Apps-segment Eliza Cloud row and deep links
 * (`eliza://apps/deploy` → `/cloud-apps`).
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { getFrontendPlatform } from "@elizaos/ui/platform";

/** Choose the provider/router wrapper owned by the current host platform. */
export function cloudAppsStudioKind(platform: string): "web" | "native" {
  return platform === "web" ? "web" : "native";
}

const studioKind = cloudAppsStudioKind(getFrontendPlatform());
const loadCloudAppsStudio =
  studioKind === "web"
    ? () => import("@elizaos/ui/cloud/applications/WebAppsStudio")
    : () => import("@elizaos/ui/cloud/applications/NativeAppsStudio");

registerAppShellPage({
  id: "cloud-apps",
  viewKind: "release",
  pluginId: "@elizaos/app",
  label: "Cloud Apps",
  icon: "Grid3x3",
  path: "/cloud-apps",
  loader: () =>
    loadCloudAppsStudio().then((module) => ({ default: module.default })),
});
