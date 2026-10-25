/**
 * A fixed GenUI spec used as the starter-pack setup demo — a stable example the
 * renderer and stories exercise.
 */
import type { ElizaGenUiSpec } from "./types";

export const ELIZA_STARTER_PACK_SETUP_SPEC: ElizaGenUiSpec = {
  version: "0.1",
  a2uiVersion: "0.9",
  root: "starter-card",
  components: [
    {
      id: "starter-card",
      component: "Card",
      child: "starter-content",
    },
    {
      id: "starter-content",
      component: "Column",
      children: ["title", "body", "actions", "secondary-actions"],
    },
    {
      id: "title",
      component: "Text",
      text: "Eliza is running locally",
      variant: "h2",
    },
    {
      id: "body",
      component: "Text",
      text: "I am using the built-in starter model. You can keep using it, download a stronger Eliza-1 model, configure voice, or connect a provider.",
      variant: "body",
    },
    {
      id: "actions",
      component: "Row",
      children: ["stay-local", "download-2b", "connect-provider"],
    },
    {
      id: "secondary-actions",
      component: "Row",
      children: ["configure-voice", "connect-connector"],
    },
    {
      id: "stay-local",
      component: "Button",
      child: "stay-local-text",
      variant: "secondary",
      action: {
        event: {
          name: "setup.dismiss",
          payload: { mode: "starter" },
        },
      },
    },
    {
      id: "stay-local-text",
      component: "Text",
      text: "Keep starter model",
    },
    {
      id: "download-2b",
      component: "Button",
      child: "download-2b-text",
      variant: "primary",
      action: {
        event: {
          name: "model.download.start",
          payload: { modelId: "eliza-1-2b" },
        },
      },
    },
    {
      id: "download-2b-text",
      component: "Text",
      text: "Download Eliza-1 2B",
    },
    {
      id: "connect-provider",
      component: "Button",
      child: "connect-provider-text",
      variant: "secondary",
      action: { event: { name: "provider.setup.open" } },
    },
    {
      id: "connect-provider-text",
      component: "Text",
      text: "Connect provider",
    },
    {
      id: "configure-voice",
      component: "Button",
      child: "configure-voice-text",
      variant: "secondary",
      action: { event: { name: "voice.start" } },
    },
    {
      id: "configure-voice-text",
      component: "Text",
      text: "Configure voice",
    },
    {
      id: "connect-connector",
      component: "Button",
      child: "connect-connector-text",
      variant: "secondary",
      action: {
        event: {
          name: "connector.setup.open",
          payload: { connectorId: "github" },
        },
      },
    },
    {
      id: "connect-connector-text",
      component: "Text",
      text: "Connect GitHub",
    },
  ],
};
