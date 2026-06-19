import type { OverlayApp } from "@elizaos/app-core";
import { registerOverlayApp } from "@elizaos/app-core";

export const IMAGEGEN_APP_NAME = "@elizaos/plugin-waifu-imagegen-app";

/**
 * Overlay-app registration for the waifu image-gen view. The loader is lazy so
 * the view's component tree (and its waifu invoke client) is only fetched when
 * the window mounts — keeping it out of the main + mobile entry chunks.
 */
export const imageGenApp: OverlayApp = {
  name: IMAGEGEN_APP_NAME,
  displayName: "Image Generation",
  description:
    "Generate images with the agent's image-gen mini-app, settled in credits",
  category: "creative",
  icon: null,
  loader: () =>
    import("./ImageGenAppView").then((m) => ({
      default: m.ImageGenAppView,
    })),
};

registerOverlayApp(imageGenApp);
