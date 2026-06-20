/**
 * In-process app-shell registration for plugin views on iOS/Android.
 *
 * On native, `DynamicViewLoader` is disabled (store policy: no remote JS at
 * runtime) and the agent strips `bundleUrl` views from `GET /api/views`, so
 * these bundled plugin views have no render path and show up as unloadable
 * "Get more" cards in the view catalog. Their React components ARE shipped in
 * the renderer bundle (the plugins are imported via `main.tsx`), so we register
 * them as in-process app-shell pages — the same mechanism
 * `orchestrator` / `wallet.inventory` / `facewear` use — so they load directly
 * from the view catalog on device.
 *
 * This module only covers plugins the app resolves to their `index.ts` barrel
 * (vincent / companion / steward). Plugins the app aliases to their `register.ts`
 * (polymarket, hyperliquid, shopify, trajectory-logger, waifu-*) register their
 * own app-shell page inside that `register.ts` instead, so the lazy loader can
 * import the view component directly and stay code-split.
 *
 * Web/desktop keep loading every one of these via `DynamicViewLoader` from the
 * agent-served bundle (deduped by view id), so the registration is native-only
 * and changes nothing off-device.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { getFrontendPlatform } from "@elizaos/ui/platform";

const platform = getFrontendPlatform();

if (platform === "android" || platform === "ios") {
  registerAppShellPage({
    id: "vincent",
    pluginId: "@elizaos/plugin-vincent",
    label: "Vincent",
    icon: "Zap",
    path: "/vincent",
    loader: () =>
      import("@elizaos/plugin-vincent").then((m) => ({
        default: m.VincentAppView,
      })),
  });

  registerAppShellPage({
    id: "companion",
    pluginId: "@elizaos/plugin-companion",
    label: "Companion",
    icon: "Bot",
    path: "/companion",
    loader: () =>
      import("@elizaos/plugin-companion").then((m) => ({
        default: m.CompanionView,
      })),
  });

  registerAppShellPage({
    id: "steward",
    pluginId: "@elizaos/plugin-steward-app",
    label: "Steward",
    icon: "Shield",
    path: "/steward",
    loader: () =>
      import("@elizaos/plugin-steward-app").then((m) => ({
        default: m.StewardView,
      })),
  });
}
