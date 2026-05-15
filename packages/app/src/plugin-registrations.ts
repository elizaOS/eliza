type SideEffectAppModuleLoader = {
  key: string;
  load: () => Promise<unknown>;
};

export const SIDE_EFFECT_APP_MODULE_LOADERS: readonly SideEffectAppModuleLoader[] =
  [
    { key: "@elizaos/app-babylon", load: () => import("@elizaos/app-babylon") },
    { key: "@elizaos/app-scape", load: () => import("@elizaos/app-scape") },
    {
      key: "@elizaos/app-hyperscape",
      load: () => import("@elizaos/app-hyperscape"),
    },
    {
      key: "@elizaos/app-2004scape",
      load: () => import("@elizaos/app-2004scape"),
    },
    {
      key: "@elizaos/app-defense-of-the-agents",
      load: () => import("@elizaos/app-defense-of-the-agents"),
    },
    {
      key: "@elizaos/app-clawville",
      load: () => import("@elizaos/app-clawville"),
    },
    {
      key: "@elizaos/app-trajectory-logger",
      load: () => import("@elizaos/app-trajectory-logger"),
    },
    { key: "@elizaos/app-shopify", load: () => import("@elizaos/app-shopify") },
    {
      key: "@elizaos/app-hyperliquid",
      load: () => import("@elizaos/app-hyperliquid"),
    },
    {
      key: "@elizaos/app-polymarket",
      load: () => import("@elizaos/app-polymarket"),
    },
    { key: "@elizaos/app-wallet", load: () => import("@elizaos/app-wallet") },
    {
      key: "@elizaos/app-contacts/register",
      load: () => import("@elizaos/app-contacts/register"),
    },
    {
      key: "@elizaos/app-device-settings/register",
      load: () => import("@elizaos/app-device-settings/register"),
    },
    {
      key: "@elizaos/app-messages/register",
      load: () => import("@elizaos/app-messages/register"),
    },
    {
      key: "@elizaos/app-phone/register",
      load: () => import("@elizaos/app-phone/register"),
    },
    {
      key: "@elizaos/app-wifi/register",
      load: () => import("@elizaos/app-wifi/register"),
    },
  ];
