import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
      // De-echoed (#9310): "remote"/"session"/"Mac" all appeared in the
      // user's own turn text. A started session hands back connection
      // details — the reply must surface them in words the prompt never used.
      responseIncludesAny: ["url", "code", "link", "connect"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm a live remote-desktop session and hand back concrete connection details (a session URL and/or pairing code), not merely restate the intent to start one.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REMOTE_DESKTOP",
      status: "success",
      minCount: 1,
    },
  ],
});
