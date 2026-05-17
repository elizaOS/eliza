import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "remote.mobile-controls-mac",
  title: "iPhone remote-control request routes into remote session handling",
  domain: "remote",
  tags: ["remote", "mobile", "routing"],
  description:
    "A request to control a Mac from an iPhone currently routes into remote-session handling instead of a direct input bridge.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote Mobile Controls Mac",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mobile-input",
      room: "main",
      text: "I'm on my iPhone and need to control my Mac remotely. Start the remote session for me. confirmed true.",
      responseIncludesAny: ["remote", "session", "Mac"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REMOTE_DESKTOP",
      minCount: 1,
    },
  ],
});
