/**
 * Storybook states for the ChatOverlay shell surface across startup,
 * launcher, banner, and overlay contexts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type * as React from "react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ChatOverlay } from "./ChatOverlay";
import type { ShellMessage } from "./shell-state";
import type { ConversationNav, ShellController } from "./useShellController";

// Mock the slice of ShellController the overlay reads — it takes the controller
// as a prop (pure/presentational), so no provider is needed.
const NOW = 1780000000000;
const MESSAGES: ShellMessage[] = [
  {
    id: "m1",
    role: "assistant",
    content:
      "Hey. This is the whole conversation — one continuous thread that lives over everything.",
    createdAt: NOW - 60000,
  },
  {
    id: "m2",
    role: "user",
    content: "so there's no separate chats?",
    createdAt: NOW - 50000,
  },
  {
    id: "m3",
    role: "assistant",
    content:
      'None. No switcher, no "new chat." Just us — one endless thread, over whatever view you open.',
    createdAt: NOW - 40000,
  },
];

// The single infinite thread (#13531): there is no chat switcher and no
// chat-to-chat swipe, so nav never has a neighbour to move to. `activeId`/`index`
// still carry the one active conversation so the overlay's data-conversation-*
// attributes render; they are required fields, so the mock supplies them (no
// partial-nav `as` escape).
const NO_NAV: ConversationNav = {
  hasPrev: false,
  hasNext: false,
  goPrev: () => {},
  goNext: () => {},
  activeId: "story-conversation",
  index: 0,
};

// A COMPLETE ShellController so the overlay renders (and runs its mount effects)
// without throwing — every method the overlay calls on mount (setDictationSink,
// setTranscriptSessionSink, setComposerHasDraft, …) must be present, not just a
// subset, so the mock is the full typed interface (no `as` escape).
function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    responding: false,
    turnStatus: null,
    messages: MESSAGES,
    canSend: true,
    modelStatus: {
      kind: "ready",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    },
    recording: false,
    waveformMode: "idle",
    analyser: null,
    open: () => {},
    close: () => {},
    isOpen: true,
    send: () => {},
    toggleRecording: () => {},
    startRecording: () => {},
    stopRecording: () => {},
    transcript: "",
    speaking: false,
    agentVoiceMuted: false,
    toggleAgentVoiceMute: () => {},
    needsAudioUnlock: false,
    unlockAudio: () => {},
    handsFree: false,
    toggleHandsFree: () => {},
    transcriptionMode: false,
    toggleTranscriptionMode: () => {},
    stopTranscriptionAndMic: () => {},
    setDictationSink: () => {},
    setTranscriptSessionSink: () => {},
    setComposerHasDraft: () => {},
    clearConversation: () => {},
    openSettings: () => {},
    stop: () => {},
    conversationNav: NO_NAV,
    conversationLoading: false,
    ...overrides,
  };
}

const Backdrop = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background:
        "radial-gradient(140% 120% at 50% -10%, #ffd9a8 0%, #f7a878 16%, #e87b6e 34%, #c2566f 52%, #7c3a63 74%, #241128 100%)",
    }}
  >
    {children}
  </div>
);

const meta = {
  title: "Shell/ChatOverlay",
  component: ChatOverlay,
  parameters: { layout: "fullscreen" },
  decorators: [
    // The overlay reads the app store via useAppSelectorShallow; seed a mock
    // app context so the stories render standalone (without the full runtime).
    (Story) => (
      <MockAppProvider>
        <Backdrop>
          <Story />
        </Backdrop>
      </MockAppProvider>
    ),
  ],
} satisfies Meta<typeof ChatOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Resting ambient bar over the warm "good evening" backdrop. */
export const Ambient: Story = { args: { controller: makeController() } };

/**
 * Login / first-run onboarding: the chat opens edge-to-edge full-bleed and the
 * composer placeholder reads "Message Eliza anything, or sign in above" — the
 * composer is typeable (#12178), so the copy invites it rather than reading as
 * locked.
 */
export const FirstRunOnboarding: Story = {
  args: {
    controller: makeController({
      messages: [
        {
          id: "first-run:greeting",
          role: "assistant",
          content:
            "Welcome. Connect to Eliza Cloud to enable chat, or set up a local model.",
          createdAt: NOW - 1000,
        },
      ],
    }),
    firstRunOpen: true,
  },
};

/** Five tailored prompt suggestions on the empty resting overlay (keyboard-strip style). */
export const PromptSuggestions: Story = {
  args: { controller: makeController({ messages: [] }) },
};

/** Listening — live interim transcript + the warm breath glow. */
export const Listening: Story = {
  args: {
    controller: makeController({
      phase: "listening",
      recording: true,
      transcript: "tell me about the gardens on the coast",
    }),
  },
};

/**
 * Voice mode (hands-free) — the composer now shows the transcription start
 * button next to the mic (#10699). The story gate captures this state.
 */
export const VoiceModeTranscription: Story = {
  args: {
    controller: makeController({
      phase: "listening",
      handsFree: true,
      recording: true,
    }),
  },
};

/** Responding — the breathing typing dots. */
export const Responding: Story = {
  args: { controller: makeController({ phase: "responding" }) },
};

/** Booting — "connecting…" placeholder, mic disabled. */
export const Booting: Story = {
  args: { controller: makeController({ phase: "booting", canSend: false }) },
};
