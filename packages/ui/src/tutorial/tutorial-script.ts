/**
 * The chat-native tutorial script: the ordered conversational turns the
 * tutorial conductor seeds into the live chat transcript. Each step is one
 * assistant turn — copy the user reads in place, a spoken line narrated
 * through the app's real voice engine, and (optionally) the cheap observation
 * that auto-advances the step when the user actually performs the action.
 * A "Next" choice always remains as the manual fallback, so a step can never
 * strand the user on a detection that doesn't fire on their device.
 *
 * The old spotlight tour's eight frames (welcome, open-chat, resize-chat,
 * ask-to-navigate, use-voice, new-chat, swipe-between-chats, done) collapse
 * into six conversational turns here: open/resize fold into the send-message
 * copy and swipe folds into new-chat, because the chat is already open when
 * the tour runs inside it.
 */

export type TutorialStepId =
  | "welcome"
  | "send-message"
  | "voice"
  | "navigate"
  | "new-chat"
  | "done";

/** Observations the conductor can watch to auto-advance a step. */
export type TutorialStepCompletion =
  | "user-message"
  | "voice-transcript"
  | "navigate-settings"
  | "new-conversation";

export interface TutorialScriptStep {
  id: TutorialStepId;
  /** On-screen turn copy (the CHOICE block is appended by the conductor). */
  text: string;
  /** Spoken line, narrated through the app's real voice engine. */
  voiceLine: string;
  /** Observation that auto-advances this step; "Next" always remains. */
  completeOn?: TutorialStepCompletion;
}

export const TUTORIAL_STEP_IDS: readonly TutorialStepId[] = [
  "welcome",
  "send-message",
  "voice",
  "navigate",
  "new-chat",
  "done",
];

/**
 * Build the tutorial script for a given agent/app name so the copy reads
 * "Hi — I'm My App" in a white-label app instead of the hardcoded "Eliza".
 * Pass the branding appName (which is also the default agent's name).
 */
export function buildTutorialScript(appName = "Eliza"): TutorialScriptStep[] {
  const name = appName.trim() || "Eliza";
  return [
    {
      id: "welcome",
      text: `Hi — I'm ${name}. Want a quick tour? It happens right here in chat, one message at a time, and takes about a minute. Tap Next when you're ready — or Stop tutorial (you can also just type "stop tutorial") to bail anytime.`,
      voiceLine: `Hi, I'm ${name}. Here's a quick tour — it all happens right here in chat.`,
    },
    {
      id: "send-message",
      text: `This chat runs everything — it floats over every screen, so I'm always one tap away. Try it: type anything below and send it. You can drag the handle above the chat to make it bigger or tuck it away.`,
      voiceLine:
        "This chat runs everything. Try sending me a message — type anything below and send it.",
      completeOn: "user-message",
    },
    {
      id: "voice",
      text: `You can talk to me too. Tap the microphone in the composer and say something — I transcribe you live, and when voice replies are on I speak my answers back.`,
      voiceLine: "You can talk to me, too. Tap the mic and say something.",
      completeOn: "voice-transcript",
    },
    {
      id: "navigate",
      text: `You never have to hunt through menus — just ask. Try sending "open settings" and I'll take you there. It works for any screen: "go home", "show my tasks", "open the launcher".`,
      voiceLine: "You can go anywhere by asking. Try: open settings.",
      completeOn: "navigate-settings",
    },
    {
      id: "new-chat",
      text: `Need a clean slate? Tap the new-chat button to start a fresh conversation — your old ones stay saved, and you can swipe left or right across the chat to move between them.`,
      voiceLine:
        "Tap new chat to start a fresh conversation. Your old ones stay saved.",
      completeOn: "new-conversation",
    },
    {
      id: "done",
      text: `That's the tour. The chat is your remote — tap, type, or talk, and ask me for anything from anywhere. Type "restart tutorial" any time to see this again.`,
      voiceLine:
        "That's it. The chat is your remote — tap, type, or talk. Have fun.",
    },
  ];
}
