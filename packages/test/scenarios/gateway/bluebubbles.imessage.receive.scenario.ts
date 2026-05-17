import { scenario } from "@elizaos/scenario-schema";
import { expectMemoryWrite } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "bluebubbles.imessage.receive",
  title:
    "BlueBubbles webhook inbound iMessage writes memory and reaches the agent",
  domain: "gateway",
  tags: ["gateway", "imessage", "bluebubbles", "smoke"],
  description:
    "A BlueBubbles webhook delivering an inbound iMessage should create the incoming message memory and route the message through the agent.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "bluebubbles",
      channelType: "DM",
      title: "BlueBubbles iMessage Receive",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "inbound-imessage",
      room: "main",
      text: "Hey, did you get my iMessage about the weekend plans?",
      responseIncludesAny: ["weekend", "iMessage", "got", "plans"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "bluebubbles-receive-inbound-memory",
      predicate: async (ctx) => {
        const inboundWrite = (ctx.memoryWrites ?? []).find((write) => {
          if (write.table !== "messages") {
            return false;
          }
          const blob = JSON.stringify(write.content ?? {});
          return (
            blob.includes('"source":"bluebubbles"') &&
            /weekend plans/i.test(blob)
          );
        });

        if (!inboundWrite) {
          return "expected a BlueBubbles inbound message memory write containing the weekend plans thread";
        }

        const turnActions = ctx.turns?.[0]?.actionsCalled ?? [];
        const syntheticReply = turnActions.find((action) => {
          if (action.actionName !== "REPLY") {
            return false;
          }
          const data =
            action.result?.data && typeof action.result.data === "object"
              ? (action.result.data as Record<string, unknown>)
              : null;
          return data?.source === "synthesized-reply";
        });
        if (syntheticReply) {
          return "expected a real inbound agent action, not a synthesized reply";
        }

        return undefined;
      },
    },
    {
      type: "custom",
      name: "bluebubbles-receive-memory-coverage",
      predicate: expectMemoryWrite({
        description: "BlueBubbles inbound memory write",
        table: "messages",
        contentIncludesAny: [/bluebubbles/i, /weekend plans/i],
      }),
    },
  ],
});
