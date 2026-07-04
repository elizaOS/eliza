/**
 * Storybook states for the ContinuousChatOverlay shell surface across startup,
 * launcher, banner, and overlay contexts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type * as React from "react";
import type { SlashCommandCatalogItem } from "../../chat/slash-menu";
import type { SlashCommandController } from "../../chat/useSlashCommandController";
import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
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

const NO_NAV: ConversationNav = {
  hasPrev: false,
  hasNext: false,
  goPrev: () => {},
  goNext: () => {},
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
  title: "Shell/ContinuousChatOverlay",
  component: ContinuousChatOverlay,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <Backdrop>
        <Story />
      </Backdrop>
    ),
  ],
} satisfies Meta<typeof ContinuousChatOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Resting ambient bar over the warm "good evening" backdrop. */
export const Ambient: Story = { args: { controller: makeController() } };

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

// ── Slash commands ──────────────────────────────────────────────────────────
// A representative catalog so the inline autocomplete + bold-in-transcript can
// be exercised live (and screenshotted via capture-slash-commands.mjs). Mirrors
// the shape served from GET /api/commands.
const SLASH_COMMANDS: SlashCommandCatalogItem[] = [
  {
    key: "settings",
    nativeName: "settings",
    description: "Open settings",
    textAliases: ["/settings", "/preferences"],
    scope: "both",
    acceptsArgs: true,
    args: [
      {
        name: "section",
        description: "Section to open",
        choices: ["model", "voice", "connectors"],
      },
    ],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "navigate", tab: "settings", path: "/settings" },
  },
  {
    key: "orchestrator",
    nativeName: "orchestrator",
    description: "Open the agent workbench",
    textAliases: ["/orchestrator", "/workbench"],
    scope: "both",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "navigate", viewId: "orchestrator", path: "/orchestrator" },
  },
  {
    key: "clear",
    nativeName: "clear",
    description: "Clear the conversation",
    textAliases: ["/clear", "/cls"],
    scope: "text",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "client", clientAction: "clear-chat" },
  },
  {
    key: "help",
    nativeName: "help",
    description: "Show what I can do",
    textAliases: ["/help"],
    scope: "both",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "agent" },
  },
];

const SLASH_CONTROLLER: SlashCommandController = {
  commands: SLASH_COMMANDS,
  loading: false,
  naturalShortcutsEnabled: false,
  isAuthorized: true,
  isElevated: true,
  resolveChoices: () => [],
  resolveSection: (t: string) =>
    ({ model: "ai-model", voice: "voice", connectors: "connectors" })[t],
  navigateTab: () => {},
  navigateSettings: () => {},
  navigateView: () => {},
  clearChat: () => {},
  openCommandPalette: () => {},
};

/**
 * Inline slash-command autocomplete. Type `/` in the composer to see the helper
 * menu with clickable suggestions; the prior user turn (`/help me out`) shows
 * the leading `/help` token rendered bold in the transcript.
 */
export const SlashCommands: Story = {
  args: {
    controller: makeController({
      messages: [
        {
          id: "s1",
          role: "assistant",
          content: "Try a slash command — type / to see what I can do.",
          createdAt: NOW - 20000,
        },
        {
          id: "s2",
          role: "user",
          content: "/help me out",
          createdAt: NOW - 10000,
        },
      ],
    }),
    slash: SLASH_CONTROLLER,
  },
};
