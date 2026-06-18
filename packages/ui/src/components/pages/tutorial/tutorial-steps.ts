/**
 * The interactive tutorial script. Each step points a glowing spotlight at one
 * real control, gives a text + voice instruction, and (where possible) AUTO-
 * ADVANCES the moment the user actually performs the action — so the tutorial
 * "checks when the user does something right". Steps with no reliable auto-signal
 * fall back to a manual Continue button (still spotlit + instructive).
 *
 * Targets are existing stable test ids on the live UI (chat-pill,
 * chat-sheet-grabber, chat-sheet, chat-composer-textarea, home-tile-settings),
 * so the spotlight always lands on the genuine control.
 */

/** Live, observable UI state the engine samples each frame (see TutorialView). */
export interface TutorialObservable {
  /** Current nav tab / view. */
  tab: string;
  /** The chat is open (not collapsed to the pill). */
  chatOpen: boolean;
  /** The chat sheet is expanded (HALF/FULL detent). */
  chatExpanded: boolean;
  /** The chat is collapsed to the small floating pill. */
  chatPilled: boolean;
  /** Seconds elapsed on the current step (drives Continue fallbacks). */
  secondsOnStep: number;
}

export interface TutorialStep {
  id: string;
  title: string;
  /** On-screen instruction. */
  body: string;
  /** Spoken instruction (TTS) in voice mode. */
  voiceLine: string;
  /** CSS selector for the control to spotlight, or null for a centered card. */
  targetSelector: string | null;
  /** Dim + block everything except the target (the "block wrong action" gate). */
  blockOutside: boolean;
  /** Auto-advance when this predicate becomes true. */
  isComplete?: (s: TutorialObservable) => boolean;
  /** Offer a manual Continue button (after `continueAfterSec`, if auto-detected). */
  manualContinue?: boolean;
  continueLabel?: string;
  /** Show the Continue fallback after N seconds even on auto-detected steps. */
  continueAfterSec?: number;
  /**
   * When the user advances this step MANUALLY (the Continue fallback) rather than
   * doing the action themselves, navigate to this tab first — so a "Take me to
   * Settings" fallback actually lands them there instead of stranding them on the
   * next step's screen. Not applied on auto-detected success (they already moved).
   */
  advanceNavigateTo?: string;
  /**
   * Navigate (advanceNavigateTo) + advance as soon as the user SENDS a message
   * during this step — so "type/say a command" steps reliably reach their
   * destination even when no model is wired to route the request itself.
   */
  advanceOnSend?: boolean;
  /** In voice mode, the command the user should speak for this step. */
  voiceCommandHint?: string;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to Eliza 👋",
    body: "Eliza is your AI agent. This 90-second tour shows you the one thing that runs everything: the chat. Ready?",
    voiceLine:
      "Welcome to Eliza, your A I agent. In about ninety seconds I'll show you how everything works. The secret is the chat. Let's go.",
    targetSelector: null,
    blockOutside: true,
    manualContinue: true,
    continueLabel: "Start the tour",
  },
  {
    id: "meet-chat",
    title: "This is your chat",
    body: "The bar at the bottom is your chat — it floats over every screen and is how you talk to Eliza by text or voice. Tap it, then continue.",
    voiceLine:
      "The bar at the bottom is your chat. It floats over every screen and it's how you talk to Eliza, by text or voice. Tap it, then press continue.",
    targetSelector: '[data-testid="chat-composer-textarea"]',
    blockOutside: false,
    manualContinue: true,
    continueLabel: "Got it",
  },
  {
    id: "expand-chat",
    title: "Make it bigger",
    body: "Drag the little handle up — or tap it — to expand the chat to full screen for longer conversations.",
    voiceLine:
      "Now make the chat bigger. Drag the handle at the top of the chat upward, or just tap it, to expand it to full screen.",
    targetSelector: '[data-testid="chat-sheet-grabber"]',
    blockOutside: false,
    isComplete: (s) => s.chatExpanded,
    continueLabel: "Skip this",
    continueAfterSec: 6,
  },
  {
    id: "minimize-chat",
    title: "Shrink it to a pill",
    body: "Now swipe down on the handle (or tap it) to collapse the whole chat into a small floating pill, out of your way.",
    voiceLine:
      "Great. Now shrink it down. Swipe down on the handle, or tap it, to collapse the chat into a small floating pill.",
    targetSelector: '[data-testid="chat-sheet-grabber"]',
    blockOutside: false,
    isComplete: (s) => s.chatPilled,
    continueLabel: "Skip this",
    continueAfterSec: 6,
  },
  {
    id: "reopen-chat",
    title: "Bring it back",
    body: "There's your pill. Tap it to open the chat again — it's always one tap away, on every screen.",
    voiceLine:
      "There's your pill. Tap it to open the chat again. It's always one tap away, on every screen.",
    targetSelector: '[data-testid="chat-pill"]',
    blockOutside: false,
    isComplete: (s) => s.chatOpen && !s.chatPilled,
    continueLabel: "Skip this",
    continueAfterSec: 6,
  },
  {
    id: "switch-by-text",
    title: "Just ask to go somewhere",
    body: "You can move around Eliza by talking to it. Open the chat and type “open settings”, then press Enter.",
    voiceLine:
      "Here's the magic: you can move around Eliza just by asking. Open the chat and type, open settings, then press enter.",
    targetSelector: '[data-testid="chat-composer-textarea"]',
    blockOutside: false,
    isComplete: (s) => s.tab === "settings",
    manualContinue: true,
    continueAfterSec: 18,
    continueLabel: "Take me to Settings",
    advanceNavigateTo: "settings",
    advanceOnSend: true,
    voiceCommandHint: "open settings",
  },
  {
    id: "settings-tour",
    title: "You're in Settings",
    body: "This is where you choose your AI model, turn voice on, connect apps, and pick local vs cloud. Have a look, then continue.",
    voiceLine:
      "Nicely done — you navigated by talking. This is Settings, where you choose your A I model, turn on voice, connect apps, and pick local or cloud. Take a look, then continue.",
    targetSelector: null,
    blockOutside: false,
    manualContinue: true,
    continueLabel: "Got it",
  },
  {
    id: "say-it",
    title: "Now try your voice",
    body: "Tap the mic in the chat and say “go home”. Eliza listens and navigates — hands-free.",
    voiceLine:
      "Let's try voice. Tap the microphone in the chat and say, go home. Eliza will take you there, hands free.",
    targetSelector: '[data-testid="chat-pill"]',
    blockOutside: false,
    isComplete: (s) => s.tab === "chat" || s.tab === "views",
    manualContinue: true,
    continueAfterSec: 16,
    continueLabel: "Skip voice",
    advanceNavigateTo: "chat",
    advanceOnSend: true,
    voiceCommandHint: "go home",
  },
  {
    id: "help",
    title: "Stuck? Open Help",
    body: "The Help tile on your home screen has searchable answers for everything — what Eliza is, models, voice, privacy, connecting apps, and more.",
    voiceLine:
      "Any time you're stuck, open the Help tile on your home screen. It has searchable answers for everything.",
    targetSelector: '[data-testid="home-tile-help"]',
    blockOutside: false,
    manualContinue: true,
    continueLabel: "Finish",
  },
  {
    id: "done",
    title: "You're ready 🎉",
    body: "That's it! The chat is your remote control — tap, expand, type, or talk. Re-run this tour any time from the Tutorial tile.",
    voiceLine:
      "That's it — you're ready. The chat is your remote control. Tap, expand, type, or talk. You can re-run this tour any time from the Tutorial tile. Have fun with Eliza.",
    targetSelector: null,
    blockOutside: true,
    manualContinue: true,
    continueLabel: "Done",
  },
];
