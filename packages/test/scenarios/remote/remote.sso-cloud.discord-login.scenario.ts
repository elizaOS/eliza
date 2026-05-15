import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "remote.sso-cloud.discord-login",
  title: "Discord remote-access login request gets manual sign-in guidance",
  domain: "remote",
  tags: ["remote", "sso", "discord", "guidance"],
  description:
    "A request to sign into remote access with Discord currently responds with manual login guidance in chat.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote SSO Discord Login",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "discord-sso",
      room: "main",
      text: "Let me log into remote access with my Discord account.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "discord-login-routing",
      predicate: async (ctx) => {
        const names = new Set(
          ctx.actionsCalled.map((action) => action.actionName),
        );
        if (names.has("REPLY") || names.has("THINK") || names.has("IGNORE")) {
          return undefined;
        }
        return `Expected Discord login flow to route through REPLY, THINK, or IGNORE. Called: ${Array.from(names).join(",") || "(none)"}`;
      },
    },
  ],
});
