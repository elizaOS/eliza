/** Default and `explainUnavailable` states for the neutral task choice leaf. */
import type { TaskChoiceWidget } from "@elizaos/core/protocol";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { TaskChoice } from "./TaskChoice";

function widget(overrides: Partial<TaskChoiceWidget> = {}): TaskChoiceWidget {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    epoch: 0,
    contextKey: "a".repeat(64),
    callbackData: `is1:${"b".repeat(32)}`,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    state: "pending",
    block: {
      kind: "choice",
      id: "method",
      scope: "task",
      prompt: "How should this bill be paid?",
      options: [
        { value: "saved", label: "Existing method" },
        { value: "new", label: "A different method" },
      ],
    },
    ...overrides,
  };
}

const expiredWidget = () =>
  widget({ expiresAt: new Date(Date.now() - 1000).toISOString() });

const meta = {
  title: "Components/TaskChoice",
  component: TaskChoice,
  parameters: { layout: "centered" },
  // The leaf is unstyled by design; this decorator stands in for host styles.
  decorators: [
    (Story) => (
      <div className="w-80 [&_button:disabled]:opacity-50 [&_button[aria-disabled=true]]:opacity-50 [&_button]:rounded-md [&_button]:border [&_button]:border-border [&_button]:px-3 [&_button]:py-2 [&_button]:text-left [&_fieldset]:flex [&_fieldset]:flex-col [&_fieldset]:gap-2 [&_legend]:mb-2 [&_legend]:font-medium [&_p]:text-sm">
        <Story />
      </div>
    ),
  ],
  args: {
    widget: widget(),
    taskId: "task-1",
    onChoose: async () => {},
  },
} satisfies Meta<typeof TaskChoice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {};

/** Default behaviour: options are disabled while a choice is in flight. */
export const InFlightDisabled: Story = { args: { pending: true } };

/** Activating an option while a choice is in flight explains why. */
export const InFlightExplained: Story = {
  args: { pending: true, explainUnavailable: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Existing method" }),
    );
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Your choice is being checked. Please wait for the result.",
    );
  },
};

export const ExpiredExplained: Story = {
  args: { widget: expiredWidget(), explainUnavailable: true },
};

/** With `explainUnavailable`, a received choice shows only its status. */
export const ReceivedExplained: Story = {
  args: { widget: widget({ state: "committed" }), explainUnavailable: true },
};
