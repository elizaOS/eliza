import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "plugin-search",
  title: "PLUGIN action search sub-mode forwards the query",
  domain: "plugin-manager",
  tags: ["plugin-manager", "plugin", "search"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-plugin-manager"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Plugin Search",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user-asks-search",
      text: "find plugins for twitter",
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
      includesAll: [/search/i, /twitter/i],
    },
    {
      type: "actionCalled",
      actionName: "PLUGIN",
      minCount: 1,
    },
  ],
});
