import type { Meta, StoryObj } from "@storybook/react";
import type * as React from "react";
import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import type { ShellController } from "./useShellController";

// Mock the slice of ShellController the overlay reads — it takes the controller
// as a prop (pure/presentational), so no provider is needed.
const NOW = 1780000000000;
const MESSAGES = [
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

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: MESSAGES,
    canSend: true,
    modelStatus: { blocksSend: false },
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
    muted: false,
    toggleMute: () => {},
    transcript: "",
    ...overrides,
  } as unknown as ShellController;
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

/** Responding — the breathing typing dots. */
export const Responding: Story = {
  args: { controller: makeController({ phase: "responding" }) },
};

/** Booting — "connecting…" placeholder, mic disabled. */
export const Booting: Story = {
  args: { controller: makeController({ phase: "booting", canSend: false }) },
};
