import type { Plugin } from "@elizaos/core";

/**
 * Waifu image-gen app-plugin.
 *
 * Pure frontend AppView: it ships a single GUI view that renders inside an
 * agent's ElizaOS web UI canvas and invokes the waifu.fun image-gen mini-app
 * endpoint directly (credits-settled). No agent routes/actions/services — the
 * backend already lives on the waifu API.
 *
 * The `views` array is the discovery + launch contract read by
 * plugin-app-manager: it points at the third-partyized view bundle
 * (`dist/views/bundle.js`) and the `ImageGenAppView` component export, and
 * marks the view visible in the app manager and as a desktop tab.
 */
export const waifuImageGenPlugin: Plugin = {
  name: "@elizaos/plugin-waifu-imagegen-app",
  description:
    "Native image-generation AppView for waifu agents — prompt, style/aspect/model selection, credits-settled invoke of the agent's image-gen mini-app",
  views: [
    {
      id: "waifu-imagegen",
      label: "Image Generation",
      description:
        "Generate images with the agent's image-gen mini-app, settled in credits",
      icon: "ImageIcon",
      heroImagePath: "assets/hero.png",
      path: "/waifu-imagegen",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ImageGenAppView",
      tags: ["creative", "image", "waifu", "generation"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "waifu-imagegen",
      label: "Image Generation XR",
      description:
        "Generate images with the agent's image-gen mini-app, settled in credits",
      icon: "ImageIcon",
      heroImagePath: "assets/hero.png",
      path: "/waifu-imagegen",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ImageGenAppView",
      tags: ["creative", "image", "waifu", "generation"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
