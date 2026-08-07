/** Loading, failed, complete, and partially degraded slash-command menus. */

import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { SlashCommandMenu, type SlashMenuState } from "./SlashCommandMenu";

const closedState: SlashMenuState = {
  open: false,
  mode: "none",
  items: [],
  activeIndex: 0,
  headerLabel: "",
  setActiveIndex: () => {},
  move: () => {},
  complete: () => null,
  resolve: () => null,
};

const openState: SlashMenuState = {
  ...closedState,
  open: true,
  mode: "command",
  headerLabel: "Commands",
  items: [
    {
      id: "settings",
      primary: "/settings",
      secondary: "Open settings",
      isCommand: true,
      hasArgs: false,
    },
    {
      id: "navigate",
      primary: "/go",
      secondary: "Navigate to a view",
      isCommand: true,
      hasArgs: true,
    },
  ],
};

let pickedIndex: number | null = null;

const meta = {
  title: "Shell/SlashCommandMenu",
  component: SlashCommandMenu,
  decorators: [
    (Story) => (
      <div className="relative mt-64 w-[28rem] max-w-[90vw]">
        <Story />
      </div>
    ),
  ],
  args: {
    state: openState,
    onPick: (index) => {
      pickedIndex = index;
    },
  },
} satisfies Meta<typeof SlashCommandMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  play: async ({ canvasElement }) => {
    pickedIndex = null;
    const firstOption = canvasElement.querySelector('[role="option"]');
    assert(
      firstOption instanceof HTMLButtonElement,
      "command option is interactive",
    );
    firstOption.click();
    assert(pickedIndex === 0, "click resolves the selected command index");
  },
};

export const PartialFailure: Story = { args: { error: true } };
export const Loading: Story = { args: { state: closedState, loading: true } };
export const Failed: Story = { args: { state: closedState, error: true } };
