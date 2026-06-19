/**
 * The interactive tour script — six frames, each pointing a glowing spotlight at
 * ONE real control. The engine (TutorialOverlay) drives the chat into a clean,
 * known state when a frame begins, narrates the line aloud through the app's real
 * voice, and auto-advances the instant the user actually performs the action.
 *
 * Frames teach the chat as the single remote control: open it, resize it, ask it
 * to navigate (the tour pre-types the request and the user just taps send), and
 * talk to it. Targets are stable test ids on the live UI (chat-pill,
 * chat-sheet-grabber, chat-composer-action, chat-composer-mic) so the spotlight
 * always lands on the genuine control.
 */

/** The chat's resting detent, read from the live `data-testid="chat-sheet"`. */
export type ChatDetent = "pill" | "collapsed" | "half" | "full";

/** Live UI state the engine samples each frame and feeds to `isDone`. */
export interface TutorialObservable {
  /** Current nav tab / view. */
  tab: string;
  /** The chat's detent (null when the chat isn't mounted yet). */
  detent: ChatDetent | null;
  /** Current composer draft text (read from the live textarea). */
  composerText: string;
  /** Live interim voice transcription ("" when not listening). */
  transcript: string;
  /**
   * True once a frame's pre-filled command has been observed and then cleared —
   * i.e. the user sent it. Used by the guided "ask to navigate" frame.
   */
  prefillSent: boolean;
  /** Seconds elapsed on the current frame. */
  secondsOnStep: number;
}

/** A single instruction within a frame (frames may have a second beat). */
export interface TutorialBeat {
  /** On-screen instruction. */
  body: string;
  /** Spoken instruction, narrated through the app's real voice. */
  voiceLine: string;
  /** Auto-advance when this becomes true. */
  isDone?: (s: TutorialObservable) => boolean;
}

export interface TutorialStep extends TutorialBeat {
  id: string;
  title: string;
  /** CSS selector for the control to spotlight, or null for a centered card. */
  targetSelector: string | null;
  /** Drive the chat into this state when the frame begins (clean per-frame state). */
  enterChat?: "pill" | "rest" | "expand";
  /** Pre-fill the composer with this command when the frame begins. */
  prefill?: string;
  /** A second instruction shown after the first beat completes (same target). */
  beat2?: TutorialBeat;
  /**
   * On success, navigate here first so the action the tour staged actually
   * completes for real (the "ask to navigate" + voice frames). Not set on frames
   * where the user's own action already moved them.
   */
  navigateOnDone?: string;
  /**
   * The only tabs navigation may reach while this frame is showing — so nothing
   * (a stray control, a deep link, an agent action) can drift the app off the
   * guided path. Include the frame's own tab plus its `navigateOnDone` target.
   * Defaults to the home base.
   */
  lockTabs?: string[];
  /** A short line shown for a beat after success, before advancing. */
  doneBody?: string;
  /** Centered cards advance with this button instead of an action. */
  manualContinue?: boolean;
  continueLabel?: string;
}

const isExpanded = (d: ChatDetent | null): boolean =>
  d === "half" || d === "full";
const isShrunk = (d: ChatDetent | null): boolean =>
  d === "collapsed" || d === "pill";

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Meet Eliza",
    body: "Your AI agent. The chat runs everything — here's the quick version.",
    voiceLine:
      "Hi, I'm Eliza, your A I agent. The chat runs everything — here's the quick version.",
    targetSelector: null,
    manualContinue: true,
    continueLabel: "Start",
  },
  {
    id: "open-chat",
    title: "Open the chat",
    body: "Tap the pill to open it.",
    voiceLine: "Tap the pill to open the chat.",
    targetSelector: '[data-testid="chat-pill"]',
    enterChat: "pill",
    isDone: (s) => s.detent != null && s.detent !== "pill",
  },
  {
    id: "resize-chat",
    title: "Resize it",
    body: "Drag the handle up to make the chat bigger.",
    voiceLine: "Drag the handle up to make the chat bigger.",
    targetSelector: '[data-testid="chat-sheet-grabber"]',
    enterChat: "rest",
    isDone: (s) => isExpanded(s.detent),
    beat2: {
      body: "Now drag it back down to tuck it away.",
      voiceLine: "Now drag it back down to tuck it away.",
      isDone: (s) => isShrunk(s.detent),
    },
  },
  {
    id: "ask-to-navigate",
    title: "Just ask",
    body: "You can ask Eliza to go anywhere. I've typed it for you — tap send.",
    voiceLine:
      "You can ask Eliza to go anywhere. I've typed it for you — tap send.",
    targetSelector: '[data-testid="chat-composer-action"]',
    enterChat: "rest",
    prefill: "open settings",
    isDone: (s) => s.prefillSent,
    navigateOnDone: "settings",
    lockTabs: ["chat", "settings"],
    doneBody: "Here's Settings.",
  },
  {
    id: "use-voice",
    title: "Talk to it",
    body: "Tap the mic and say “go home”.",
    voiceLine: "You can talk to me, too. Tap the mic and say: go home.",
    targetSelector: '[data-testid="chat-composer-mic"]',
    enterChat: "rest",
    isDone: (s) => /\bhome\b/i.test(s.transcript),
    navigateOnDone: "chat",
    lockTabs: ["settings", "chat"],
    doneBody: "Welcome home.",
  },
  {
    id: "done",
    title: "You're set",
    body: "The chat is your remote — tap, drag, type, or talk. Re-run this tour anytime from the Tutorial tile.",
    voiceLine:
      "That's it. The chat is your remote — tap, drag, type, or talk. Have fun.",
    targetSelector: null,
    manualContinue: true,
    continueLabel: "Done",
  },
];
