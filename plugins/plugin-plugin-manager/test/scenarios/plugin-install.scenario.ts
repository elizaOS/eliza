import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "plugin-install",
  title: "PLUGIN action install sub-mode targets the named plugin",
  domain: "plugin-manager",
  tags: ["plugin-manager", "plugin", "install", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-plugin-manager"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Plugin Install",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user-asks-install",
      text: "install the discord plugin",
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
      includesAll: [/install/i],
      includesAny: [/discord/i],
    },
    {
      type: "actionCalled",
      actionName: "PLUGIN",
      minCount: 1,
    },
  ],
});
