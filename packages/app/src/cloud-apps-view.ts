/**
 * In-process app-shell registration for the Eliza Cloud **Applications**
 * dashboard on native runtimes (iOS / Android / Electrobun desktop).
 *
 * On the web build the Applications surfaces are served by the top-level
 * `CloudRouterShell` `<BrowserRouter>` (mounted only when `__ELIZA_WEB_SHELL__`
 * is true). Native runtimes never mount that shell — the renderer boots the
 * tab/view `App` directly — so the same Applications components are surfaced
 * here as an in-process app-shell page that mounts the self-contained
 * `NativeAppsStudio` (a `MemoryRouter` + cloud providers + native Steward auth
 * context; see `@elizaos/ui/cloud/applications/NativeAppsStudio`).
 *
 * This uses the in-process app-shell registration mechanism (the same one
 * `orchestrator` / `wallet.inventory` use). It is gated to non-web platforms so
 * it never competes with the web shell's route, and the import stays **lazy**
 * (the studio chunk — and the whole applications domain it pulls — loads only
 * when the Apps view is opened), preserving the native bundle's tree-shake.
 *
 * The page id is `cloud-apps` (the local installed-`AppsView` owns `apps`), the
 * route is `/cloud-apps`, and the label is "Apps".
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { getFrontendPlatform } from "@elizaos/ui/platform";

// "web" → served by CloudRouterShell; every other platform (ios / android /
// desktop) boots the tab/view app directly and needs this in-process mount.
if (getFrontendPlatform() !== "web") {
  registerAppShellPage({
    id: "cloud-apps",
    viewKind: "release",
    pluginId: "@elizaos/app",
    label: "Apps",
    icon: "Grid3x3",
    path: "/cloud-apps",
    loader: () =>
      import("@elizaos/ui/cloud/applications/NativeAppsStudio").then((m) => ({
        default: m.default,
      })),
  });
}
