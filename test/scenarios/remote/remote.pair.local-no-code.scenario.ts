import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "remote.pair.local-no-code",
  title: "Local pairing request returns in-device instructions",
  domain: "remote",
  tags: ["remote", "pairing", "local"],
  description:
    "A local pairing request currently responds with in-device pairing guidance on the same network.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote Pair Local No Code",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "pair-locally",
      room: "main",
      text: "Pair my companion client. I'm on the same machine.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "LIST_ACTIVE_BLOCKS",
      minCount: 1,
    },
  ],
});
