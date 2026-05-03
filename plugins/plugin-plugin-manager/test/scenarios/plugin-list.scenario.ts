import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "plugin-list",
  title: "PLUGIN action list sub-mode reports loaded plugins",
  domain: "plugin-manager",
  tags: ["plugin-manager", "plugin", "list"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-plugin-manager"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Plugin List",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user-asks-list",
      text: "list my plugins",
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
      includesAll: [/list/i],
    },
    {
      type: "actionCalled",
      actionName: "PLUGIN",
      minCount: 1,
    },
  ],
});
