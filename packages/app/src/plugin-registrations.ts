type SideEffectAppModuleLoader = {
  key: string;
  load: () => Promise<unknown>;
};

export const SIDE_EFFECT_APP_MODULE_LOADERS: readonly SideEffectAppModuleLoader[] =
  [
    {
      key: "@elizaos/plugin-babylon",
      load: () => import("@elizaos/plugin-babylon"),
    },
    {
      key: "@elizaos/plugin-scape",
      load: () => import("@elizaos/plugin-scape"),
    },
    {
      key: "@elizaos/plugin-hyperscape",
      load: () => import("@elizaos/plugin-hyperscape"),
    },
    {
      key: "@elizaos/plugin-2004scape",
      load: () => import("@elizaos/plugin-2004scape"),
    },
    {
      key: "@elizaos/plugin-defense-of-the-agents",
      load: () => import("@elizaos/plugin-defense-of-the-agents"),
    },
    {
      key: "@elizaos/plugin-clawville",
      load: () => import("@elizaos/plugin-clawville"),
    },
    {
      key: "@elizaos/plugin-trajectory-logger",
      load: () => import("@elizaos/plugin-trajectory-logger"),
    },
    {
      key: "@elizaos/plugin-shopify-ui",
      load: () => import("@elizaos/plugin-shopify-ui"),
    },
    {
      key: "@elizaos/plugin-hyperliquid-app",
      load: () => import("@elizaos/plugin-hyperliquid-app"),
    },
    {
      key: "@elizaos/plugin-polymarket-app",
      load: () => import("@elizaos/plugin-polymarket-app"),
    },
    {
      key: "@elizaos/plugin-wallet-ui",
      load: () => import("@elizaos/plugin-wallet-ui"),
    },
    {
      key: "@elizaos/plugin-contacts/register",
      load: () => import("@elizaos/plugin-contacts/register"),
    },
    {
      key: "@elizaos/plugin-device-settings/register",
      load: () => import("@elizaos/plugin-device-settings/register"),
    },
    {
      key: "@elizaos/plugin-messages/register",
      load: () => import("@elizaos/plugin-messages/register"),
    },
    {
      key: "@elizaos/plugin-phone/register",
      load: () => import("@elizaos/plugin-phone/register"),
    },
    {
      key: "@elizaos/plugin-wifi/register",
      load: () => import("@elizaos/plugin-wifi/register"),
    },
  ];
