/**
 * The `@elizaos/plugin-messages` Plugin object: declares a passive `sms`
 * connector source and registers the Android SMS "messages" surface as a single
 * view spanning the GUI, XR, and TUI modalities, all drawn from the one
 * MessagesView bundle export (`dist/views/bundle.js`). Registers no actions,
 * providers, evaluators, or services.
 */

import type { Plugin } from "@elizaos/core";

export const appMessagesPlugin: Plugin = {
  name: "@elizaos/plugin-messages",
  description:
    "Android Messages overlay: read SMS conversations and compose text messages through the native SMS bridge.",
  connectorSources: [
    {
      source: "sms",
      aliases: ["sms"],
      sourceKind: "passive",
      isPassive: true,
    },
  ],
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single MessagesView
    // spatial source. `modalities` is a plain literal here (plugin.ts is not in
    // the view bundle), so no brand-new `@elizaos/core` runtime export reaches
    // the bundle build.
    {
      id: "messages",
      label: "Messages",
      description: "SMS conversations via the Android Messages bridge",
      icon: "MessageSquare",
      path: "/messages",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "MessagesView",
      tags: ["messaging", "sms", "android"],
      visibleInManager: true,
      desktopTabEnabled: true,
      nativeOs: true,
    },
  ],
};

export default appMessagesPlugin;
