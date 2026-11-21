// spec/agent/conversation/replyStream.md, "Story: See a reply as it is written"
import type { Driver, Options } from "../../gen/agent__conversation__replyStream.conformance.ts";
import type { Event, Phase, ReplyStream } from "../../gen/agent__conversation__replyStream.ts";
import { ReplyWire } from "../../src/conversation/stream.vibe";

const textOf = (units: readonly number[]) => String.fromCharCode(...units);
const unreplied = (phase: Phase): Phase => {
  switch (phase.tag) {
    case "Finishing": return phase.end.tag === "Done" ? { tag: "Finishing", end: { ...phase.end, reply: 0 } } : phase;
    case "Ended": return phase.sent.tag === "Done" ? { tag: "Ended", sent: { ...phase.sent, reply: 0 } } : phase;
    case "Open": case "Dropped": return phase;
  }
};

let wire = new ReplyWire({ write: () => undefined, abortTurn: () => undefined });

function send(event: Event): boolean {
  switch (event.type) {
    case "admit": return wire.admit(event.verdict);
    case "frameFlushed": return wire.flushed();
    case "appendText": return wire.append(textOf(event.units), event.provisional);
    case "replaceText": return wire.replace(textOf(event.units), event.provisional);
    case "restartText": return wire.restart(textOf(event.units), event.provisional);
    case "showProgress": return wire.progress(event.progress);
    case "announceReply": return wire.ready(textOf(event.units), Array.from({ length: event.results }, () => ({ action: "CALCULATE", data: {} })));
    case "finish": return event.reply >= 1 && wire.finish({
      type: "done", fullText: textOf(event.units), messageId: "reply", userMessageId: "message", agentName: "agent", kind: event.kind,
      actionResults: Array.from({ length: event.results }, () => ({ action: "CALCULATE", data: {} })),
    });
    case "answerError": return wire.finish({ type: "error", code: event.code, message: "The turn left no reply" });
    case "clientLeft": return wire.leave();
  }
}

export const driver: Driver<ReplyStream> = {
  reset: () => { wire = new ReplyWire({ write: () => undefined, abortTurn: () => undefined }); },
  dispatch: (_key, event) => send(event) ? "accepted" : "refused",
  observe: () => ({ ...wire.state, phase: unreplied(wire.state.phase) }),
};

export const options: Options<ReplyStream> = {
  view: (state) => ({ ...state, phase: unreplied(state.phase) }),
  keys: ["request"],
};
