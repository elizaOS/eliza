import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { successfulActionData } from "../_helpers/effect-assertions.ts";

function expectRemoteSessionConnectionInfo(
  ctx: ScenarioContext,
): string | undefined {
  const data = successfulActionData(ctx, "REMOTE_DESKTOP") as {
    session?: {
      status?: string;
      accessUrl?: string | null;
      accessCode?: string | null;
    };
  } | null;
  if (!data) {
    return "expected successful REMOTE_DESKTOP result data";
  }
  const session = data.session;
  if (session?.status !== "active") {
    return `expected active remote desktop session, saw ${JSON.stringify(session ?? null)}`;
  }
  if (!session.accessUrl && !session.accessCode) {
    return `expected session accessUrl or accessCode, saw ${JSON.stringify(session)}`;
  }
  return undefined;
}

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
      type: "custom",
      name: "mobile-control-starts-remote-session",
      predicate: expectRemoteSessionConnectionInfo,
    },
  ],
});
