import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "remote.vnc.start-session",
  title: "Start a remote VNC session on user request",
  domain: "remote",
  tags: ["remote", "vnc", "happy-path"],
  description:
    "User asks the agent to open a remote-help session; the remote-desktop action should return concrete connection info including a session URL and pairing code.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote VNC Start Session",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "start-vnc",
      room: "main",
      text: "Start a remote desktop session for me from my phone. confirmed true. Give me the session URL and pairing code.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["REMOTE_DESKTOP"],
        description: "remote desktop session start",
      }),
      responseIncludesAny: ["remote", "session", "pairing", "url"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "REMOTE_DESKTOP",
    },
    {
      type: "custom",
      name: "remote-vnc-start-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["REMOTE_DESKTOP"],
        description: "remote desktop session start",
      }),
    },
    {
      type: "custom",
      name: "remote-vnc-start-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "REMOTE_DESKTOP",
        );
        if (!hit) {
          return "expected REMOTE_DESKTOP action result";
        }
        const data = (hit.result?.data ?? {}) as {
          session?: {
            status?: string;
            accessUrl?: string | null;
            accessCode?: string | null;
          };
        };
        if (data.session?.status !== "active") {
          return "expected active remote desktop session";
        }
        if (
          typeof data.session?.accessUrl !== "string" ||
          data.session.accessUrl.length === 0
        ) {
          return "expected accessUrl in remote desktop session result";
        }
        if (
          typeof data.session?.accessCode !== "string" ||
          data.session.accessCode.length === 0
        ) {
          return "expected accessCode in remote desktop session result";
        }
        return undefined;
      },
    },
  ],
});
