// spec/agent/voice/session.md, "Story: Send my words once I finish speaking"
import type { Driver, Options } from "../../gen/agent__voice__session.conformance.ts";
import type { Event, VoiceSession as SessionState } from "../../gen/agent__voice__session.ts";
import type { CaptureEvents, SpeakerEvents } from "../../src/voice/ports.vibe";
import { VoiceSession } from "../../src/voice/session.vibe";

const never = <A>() => new Promise<A>(() => undefined);

function harness() {
  const held: { capture?: CaptureEvents; speaker?: SpeakerEvents } = {};
  const session = new VoiceSession({
    conversationId: "conversation",
    roomId: "room",
    capture: { open: (_request, events) => { held.capture = events; }, close: () => undefined },
    endOfTurn: never,
    turns: { send: never, abort: async () => undefined },
    heard: never,
    speaker: { speak: (_segments, events) => { held.speaker = events; }, stop: () => undefined },
    clock: { now: () => 0, after: () => undefined },
    clientMessageId: () => "client-message",
  });
  return { session, held };
}

let current = harness();

function send(event: Event): void {
  const { session, held } = current;
  switch (event.type) {
    case "start": session.start(event.mode, event.duplex); return;
    case "stop": session.stop(); return;
    case "captureOpened": held.capture?.opened({ echoCancelled: false }); return;
    case "captureClosed": held.capture?.closed(); return;
    case "captureFailed": held.capture?.failed(new Error("capture failed")); return;
    case "speechStarted": session.onSpeechStart(); return;
    case "speechEnded": session.onSpeechEnd(); return;
    case "bargeInHeld": session.onHold(event.heldMs); return;
    case "segmentPlayed": held.speaker?.segmentPlayed(); return;
    case "playbackBroke": held.speaker?.broke(new Error("playback broke")); return;
    case "reopenCapture": case "shortGapElapsed": case "longGapElapsed": case "endOfTurnAnswered": case "sendTurn":
    case "finalTranscript": case "replyStarted": case "replyFailed": case "dispatchHeard": case "heardAnswered":
      session.dispatch(event);
      return;
  }
}

export const driver: Driver<SessionState> = {
  reset: () => { current = harness(); },
  dispatch: (_key, event) => {
    const before = current.session.state;
    send(event);
    return current.session.state === before ? "refused" : "accepted";
  },
  observe: () => current.session.state,
};

export const options: Options<SessionState> = { keys: ["session"] };
