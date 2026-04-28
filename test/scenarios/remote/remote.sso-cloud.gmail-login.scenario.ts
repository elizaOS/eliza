import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "remote.sso-cloud.gmail-login",
  title: "Google remote-access login request gets manual sign-in guidance",
  domain: "remote",
  tags: ["remote", "sso", "google", "guidance"],
  description:
    "A request to sign into remote access with Google currently responds with manual login guidance in chat.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote SSO Gmail Login",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "gmail-sso",
      room: "main",
      text: "Let me log into remote access with my Google account.",
      responseIncludesAny: [
        "Google",
        "sign in",
        "login",
        "accounts.google.com",
      ],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
  ],
});
