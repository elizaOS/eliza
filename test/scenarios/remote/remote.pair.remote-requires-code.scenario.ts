import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "remote.pair.remote-requires-code",
  title: "Remote pairing request falls back to generic pairing guidance",
  domain: "remote",
  tags: ["remote", "pairing", "guidance"],
  description:
    "A remote pairing request currently responds with generic device-pairing guidance in chat.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote Pair Requires Code",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "pair-remote",
      room: "main",
      text: "I want to pair a new device from my phone across the internet.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "remote-pair-guidance-routing",
      predicate: async (ctx) => {
        const names = new Set(
          ctx.actionsCalled.map((action) => action.actionName),
        );
        if (
          names.has("REPLY") ||
          names.has("THINK") ||
          names.has("USE_SKILL")
        ) {
          return undefined;
        }
        return `Expected remote pairing flow to route through REPLY, THINK, or USE_SKILL. Called: ${Array.from(names).join(",") || "(none)"}`;
      },
    },
  ],
});
