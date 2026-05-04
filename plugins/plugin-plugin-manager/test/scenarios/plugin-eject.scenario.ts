import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "plugin-eject",
  title: "PLUGIN action eject sub-mode targets the named plugin",
  domain: "plugin-manager",
  tags: ["plugin-manager", "plugin", "eject"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-plugin-manager"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Plugin Eject",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user-asks-eject",
      text: "eject the github plugin",
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
      includesAll: [/eject/i],
      includesAny: [/github/i],
    },
    {
      type: "actionCalled",
      actionName: "PLUGIN",
      minCount: 1,
    },
  ],
});
