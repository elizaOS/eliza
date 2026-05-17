import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "remote.vnc.revoke-session",
  title: "Ending a remote session asks for confirmation",
  domain: "remote",
  tags: ["remote", "vnc", "confirmation"],
  description:
    "A request to end the current remote session currently routes through a confirmation-style release flow.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote VNC Revoke Session",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "revoke-vnc",
      room: "main",
      text: "End the remote session now.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "remote-session-end-routing",
      predicate: async (ctx) => {
        const names = new Set(
          ctx.actionsCalled.map((action) => action.actionName),
        );
        if (
          names.has("RELEASE_BLOCK") ||
          names.has("REPLY") ||
          names.has("IGNORE")
        ) {
          return undefined;
        }
        return `Expected remote session end flow to route through RELEASE_BLOCK, REPLY, or IGNORE. Called: ${Array.from(names).join(",") || "(none)"}`;
      },
    },
  ],
});
