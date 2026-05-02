import { scenario } from "@elizaos/scenario-schema";

/**
 * Multi-turn create flow:
 *   Turn 1 — user asks to "build a plugin for sending push notifications".
 *            PLUGIN action fires in `mode=create`. When candidate plugins
 *            fuzzy-match, the assistant emits a [CHOICE:plugin-create ...]
 *            block.
 *   Turn 2 — user replies "edit-1". PLUGIN re-validates because the choice
 *            reply matches a pending plugin-create-intent task; mode is
 *            still `create` and the choice resolves to an edit dispatch.
 */
export default scenario({
  id: "plugin-create-with-picker",
  title: "PLUGIN create — picker shown then edit-1 selected",
  domain: "plugin-manager",
  tags: ["plugin-manager", "plugin", "create", "multi-turn"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-plugin-manager"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Plugin Create Picker",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user-asks-create",
      text: "build a plugin for sending push notifications",
    },
    {
      kind: "message",
      name: "user-picks-edit-1",
      text: "edit-1",
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "PLUGIN",
    },
    {
      type: "selectedActionArguments",
      actionName: "PLUGIN",
      includesAny: [/create/i],
    },
    {
      type: "actionCalled",
      actionName: "PLUGIN",
      minCount: 2,
    },
    {
      type: "messageDelivered",
      channel: "telegram",
    },
  ],
});
