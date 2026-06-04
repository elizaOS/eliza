import type { Meta, StoryObj } from "@storybook/react";
import { GlassIconButton } from "./glass-composer";
import { GLASS_COMPOSER_CLASS } from "./glass-composer.helpers";

// White negative-space glyphs read against a warm glass backdrop.
const Backdrop = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      display: "grid",
      placeItems: "center",
      padding: 48,
      background:
        "radial-gradient(140% 120% at 50% -10%, #f7a878 0%, #c2566f 45%, #241128 100%)",
    }}
  >
    {children}
  </div>
);

const meta = {
  title: "Shell/GlassComposer",
  component: GlassIconButton,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <Backdrop>
        <Story />
      </Backdrop>
    ),
  ],
  argTypes: {
    icon: { control: "inline-radio", options: ["mic", "send"] },
    label: { control: "text" },
    disabled: { control: "boolean" },
    active: { control: "boolean" },
  },
  args: { icon: "send", label: "Send message", disabled: false, active: false },
} satisfies Meta<typeof GlassIconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Send control — the up-arrow glyph cut out of the white button. */
export const Send: Story = {};

/** Mic control — the five-bar waveform glyph. */
export const Mic: Story = {
  args: { icon: "mic", label: "Hold to talk" },
};

/** Mic while recording — pulses and reports aria-pressed. */
export const MicActive: Story = {
  args: { icon: "mic", label: "Stop recording", active: true },
};

/** Disabled — dimmed, no hover scale. */
export const Disabled: Story = {
  args: { disabled: true },
};

/** Both controls inside the refractive glass composer bar. */
export const ComposerBar: Story = {
  render: () => (
    <div className={GLASS_COMPOSER_CLASS} style={{ minWidth: 260 }}>
      <input
        aria-label="Message"
        placeholder="Message…"
        className="flex-1 bg-transparent px-2 text-sm text-txt outline-none placeholder:text-txt/50"
      />
      <GlassIconButton icon="mic" label="Hold to talk" />
      <GlassIconButton icon="send" label="Send message" />
    </div>
  ),
};
