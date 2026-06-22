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
 * plugin-app-manager: ONE declaration → GUI + XR + TUI, all drawn from the
 * single `ImageGenView` spatial source. `modalities` is a plain literal here
 * (plugin.ts is not in the view bundle), so no brand-new `@elizaos/core` runtime
 * export reaches the bundle build.
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
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "ImageGenView",
      tags: ["creative", "image", "waifu", "generation"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
