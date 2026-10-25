// Closed external consumer: no microphone, network, synthesis or playback APIs.
import {
  ElizaError,
  sanitizeSpeechText,
  trimEndCharacters,
} from "@elizaos/core/speech";
import { BatchVoiceConversation } from "@elizaos/ui/voice/batch-conversation";
import {
  buildVoiceTurnSignal,
  scoreEndOfTurnHeuristic,
} from "@elizaos/voice/turn";

function check(value, message) {
  if (!value) throw Error(message);
}
check(
  sanitizeSpeechText("<think>Private.</think>Hello.") === "Hello.",
  "Canonical speech sanitizer",
);
check(
  trimEndCharacters("Hello...", ".") === "Hello",
  "Canonical boundary trim",
);
check(
  new ElizaError("Expected", { code: "CONSUMER_CHECK" }).code ===
    "CONSUMER_CHECK",
  "Public typed error",
);
check(scoreEndOfTurnHeuristic("What time is it?") > 0.5, "Canonical EOT");
check(!!buildVoiceTurnSignal("What time is it?", {}), "Public voice signal");
let now = 0,
  input,
  captures = 0,
  transcribes = 0,
  sends = 0,
  speeches = 0,
  cancels = 0,
  valid = true;
const timers = new Map();
let nextTimer = 0;
const loop = new BatchVoiceConversation(
  {
    conversationId: "owned-room",
    assertCurrent() {
      if (!valid) throw Error("Retired owner");
    },
    async capture(value) {
      captures++;
      input = value;
      return {
        async stop() {
          return "owned-clip";
        },
        async cancel() {
          cancels++;
        },
      };
    },
    async transcribe(clip) {
      check(clip === "owned-clip", "Owned capture");
      transcribes++;
      return "What time is it?";
    },
    async send(turn) {
      sends++;
      check(
        turn.text === "What time is it?" && !!turn.voiceTurnSignal,
        "Only recognized turn",
      );
      return {
        requestId: turn.turnId,
        conversationId: "owned-room",
        userMessageId: "user",
        assistantMessageId: "queued-assistant",
        text: "Review the owned request.",
        complete: false,
        awaitingUserInput: {
          proposalId: "owned-proposal",
          digest: "owned-digest",
        },
      };
    },
    async speak(turn) {
      check(
        turn.replyId === "assistant" && turn.text === "It is noon.",
        "Exact assistant reply",
      );
      speeches++;
      turn.onStarted();
    },
  },
  {
    clock: {
      now: () => now,
      setTimer: (fn) => {
        const id = ++nextTimer;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  },
);
await loop.start();
now = 300;
input.onActivity({ peak: 0.2 });
now = 600;
input.onActivity({ peak: 0.2 });
now = 1300;
input.onActivity({ peak: 0 });
for (let i = 0; i < 100; i++) await Promise.resolve();
const paused = loop.getSnapshot();
check(
  paused.phase === "awaiting-user-input" &&
    captures === 1 &&
    sends === 1 &&
    speeches === 0,
  "Packed owner-input pause holds media",
);
const pause = paused.awaitingUserInput;
check(loop.resume(null) === false, "Malformed public resume is rejected");
check(
  loop.resume({
    pause,
    reply: {
      requestId: pause.requestId,
      conversationId: pause.conversationId,
      userMessageId: pause.userMessageId,
      assistantMessageId: 7,
      text: "Wrong reply",
      complete: true,
    },
  }) === false,
  "Non-string assistant identity cannot resume",
);
check(
  loop.resume({
    pause,
    reply: {
      requestId: pause.requestId,
      conversationId: pause.conversationId,
      userMessageId: pause.userMessageId,
      assistantMessageId: "assistant",
      text: "It is noon.",
      complete: true,
    },
  }),
  "Packed exact original-turn continuation",
);
for (let i = 0; i < 100; i++) await Promise.resolve();
check(
  captures === 1 && transcribes === 1 && sends === 1 && speeches === 1,
  "Packed complete matching turn",
);
await loop.stop();
valid = false;
input.onActivity({ peak: 1 });
for (let i = 0; i < 20; i++) await Promise.resolve();
check(
  captures === 1 && sends === 1 && cancels === 1,
  "Retirement prevents replay",
);
globalThis.batchVoicePackageReceipt = {
  captures,
  transcribes,
  sends,
  speeches,
  cancels,
};
