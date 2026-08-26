/**
 * The `@elizaos/plugin-messages` Plugin object: declares a passive `sms`
 * connector source and registers the Android SMS "messages" GUI surface from
 * the one MessagesView bundle export (`dist/views/bundle.js`). Registers no
 * actions, providers, evaluators, or services.
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
    // One shipped GUI declaration drawn from MessagesView. The modality enum is
    // retained in the contract for future alternate view entries.
    {
      id: "messages",
      label: "Messages",
      description: "SMS conversations via the Android Messages bridge",
      icon: "MessageSquare",
      path: "/messages",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "MessagesView",
      tags: ["messaging", "sms", "android"],
      responseContext: { primaryContext: "messaging" },
      visibleInManager: true,
      desktopTabEnabled: true,
      nativeOs: true,
    },
  ],
};

export default appMessagesPlugin;
