import type { Meta, StoryObj } from "@storybook/react";
import {
  HEADER_BUTTON_STYLE,
  SHELL_CONTROL_BASE_CLASSNAME,
  SHELL_EXPANDED_BUTTON_CLASSNAME,
  SHELL_ICON_BUTTON_CLASSNAME,
  SHELL_SEGMENTED_CONTROL_CLASSNAME,
  SHELL_SEGMENT_ACTIVE_CLASSNAME,
  SHELL_SEGMENT_INACTIVE_CLASSNAME,
} from "./shell-control-styles";

function ShellControlsGallery() {
  return (
    <div className="flex flex-col gap-6 p-8">
      <section>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">
          Icon Buttons
        </h3>
        <div className="flex gap-3">
          <button
            type="button"
            className={SHELL_ICON_BUTTON_CLASSNAME}
            style={HEADER_BUTTON_STYLE}
          >
            A
          </button>
          <button
            type="button"
            className={SHELL_ICON_BUTTON_CLASSNAME}
            style={HEADER_BUTTON_STYLE}
            disabled
          >
            B
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">
          Expanded Buttons
        </h3>
        <div className="flex gap-3">
          <button
            type="button"
            className={SHELL_EXPANDED_BUTTON_CLASSNAME}
            style={HEADER_BUTTON_STYLE}
          >
            English
          </button>
          <button
            type="button"
            className={SHELL_EXPANDED_BUTTON_CLASSNAME}
            style={HEADER_BUTTON_STYLE}
          >
            Cloud Status
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">
          Segmented Control
        </h3>
        <div className={SHELL_SEGMENTED_CONTROL_CLASSNAME}>
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${SHELL_SEGMENT_ACTIVE_CLASSNAME}`}
          >
            Companion
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${SHELL_SEGMENT_INACTIVE_CLASSNAME}`}
          >
            Character
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">
          Base Control
        </h3>
        <button
          type="button"
          className={`rounded-xl px-4 py-2 ${SHELL_CONTROL_BASE_CLASSNAME}`}
        >
          Base Control Style
        </button>
      </section>
    </div>
  );
}

const meta = {
  title: "Companion/ShellControlStyles",
  component: ShellControlsGallery,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ShellControlsGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
