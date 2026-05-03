import { scenario } from "@elizaos/scenario-schema";

/**
 * Multi-turn create-then-cancel flow.
 *   Turn 1 — "create a plugin for managing api keys" → picker shown.
 *   Turn 2 — "cancel" → PLUGIN action validates the choice reply against
 *            the pending intent task, deletes it, and confirms cancellation.
 */
export default scenario({
  id: "plugin-create-cancel",
  title: "PLUGIN create — user cancels at the picker",
  domain: "plugin-manager",
  tags: ["plugin-manager", "plugin", "create", "cancel"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-plugin-manager"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Plugin Create Cancel",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user-asks-create",
      text: "create a plugin for managing api keys",
    },
    {
      kind: "message",
      name: "user-cancels",
      text: "cancel",
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
      type: "judgeRubric",
      name: "cancel-confirmation",
      rubric:
        "After turn 2, the assistant must acknowledge the cancellation with text such as 'canceled' or 'no plugin changes made'. It must NOT claim it scaffolded, created, or dispatched a coding agent for the plugin.",
      minimumScore: 0.7,
    },
  ],
});
