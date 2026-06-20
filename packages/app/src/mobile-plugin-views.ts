/**
 * In-process app-shell registration for plugin views on iOS/Android.
 *
 * On native, `DynamicViewLoader` is disabled (store policy: no remote JS at
 * runtime) and the agent strips `bundleUrl` views from `GET /api/views`, so
 * these bundled plugin views have no render path and show up as unloadable
 * "Get more" cards in the view catalog. Their React components ARE shipped in
 * the renderer bundle (the plugins are imported via `plugin-registrations.ts` /
 * `main.tsx`), so we register them as in-process app-shell pages — the same
 * mechanism `orchestrator` / `wallet.inventory` / `facewear` use — so they load
 * directly from the view catalog on device.
 *
 * Web/desktop keep loading these via `DynamicViewLoader` from the agent-served
 * bundle, so the registration is native-only and changes nothing off-device.
 * Each loader uses a static import specifier so the bundler can code-split the
 * view component and only fetch it when the page is opened.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { getFrontendPlatform } from "@elizaos/ui/platform";

const platform = getFrontendPlatform();

if (platform === "android" || platform === "ios") {
  registerAppShellPage({
    id: "trajectory-logger",
    pluginId: "@elizaos/plugin-trajectory-logger",
    label: "Trajectory Logger",
    icon: "Activity",
    path: "/trajectory-logger",
    loader: () =>
      import("@elizaos/plugin-trajectory-logger").then((m) => ({
        default: m.TrajectoryLoggerView,
      })),
  });

  registerAppShellPage({
    id: "polymarket",
    pluginId: "@elizaos/plugin-polymarket-app",
    label: "Polymarket",
    icon: "BarChart2",
    path: "/polymarket",
    loader: () =>
      import("@elizaos/plugin-polymarket-app").then((m) => ({
        default: m.PolymarketAppView,
      })),
  });

  registerAppShellPage({
    id: "hyperliquid",
    pluginId: "@elizaos/plugin-hyperliquid-app",
    label: "Hyperliquid",
    icon: "TrendingUp",
    path: "/hyperliquid",
    loader: () =>
      import("@elizaos/plugin-hyperliquid-app").then((m) => ({
        default: m.HyperliquidAppView,
      })),
  });

  registerAppShellPage({
    id: "shopify",
    pluginId: "@elizaos/plugin-shopify-ui",
    label: "Shopify",
    icon: "ShoppingBag",
    path: "/shopify",
    loader: () =>
      import("@elizaos/plugin-shopify-ui").then((m) => ({
        default: m.ShopifyAppView,
      })),
  });

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

  registerAppShellPage({
    id: "waifu-imagegen",
    pluginId: "@elizaos/plugin-waifu-imagegen-app",
    label: "Image Generation",
    icon: "Image",
    path: "/waifu-imagegen",
    loader: () =>
      import("@elizaos/plugin-waifu-imagegen-app").then((m) => ({
        default: m.ImageGenAppView,
      })),
  });

  registerAppShellPage({
    id: "waifu-swap",
    pluginId: "@elizaos/plugin-waifu-swap-app",
    label: "Swap",
    icon: "ArrowLeftRight",
    path: "/waifu-swap",
    loader: () =>
      import("@elizaos/plugin-waifu-swap-app").then((m) => ({
        default: m.SwapAppView,
      })),
  });
}
