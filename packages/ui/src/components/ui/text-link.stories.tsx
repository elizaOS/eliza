/** Storybook fixtures covering semantic text-link presentations and their click behavior. */
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { userEvent } from "storybook/test";
import { assert } from "../../storybook/home-widget-decorator";
import { TextLink, type TextLinkProps } from "./text-link";

function InteractiveLink(props: TextLinkProps) {
  const [activated, setActivated] = useState(false);

  return (
    <div className="flex flex-col items-start gap-3">
      <TextLink
        {...props}
        onClick={(event) => {
          event.preventDefault();
          setActivated(true);
          props.onClick?.(event);
        }}
      />
      <span aria-live="polite" className="text-sm text-muted" role="status">
        {activated ? "Documentation link activated." : "Link not activated."}
      </span>
    </div>
  );
}

const meta = {
  title: "Primitives/TextLink",
  component: TextLink,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    variant: {
      control: "select",
      options: ["accent", "instruction"],
    },
  },
  args: {
    children: "Open agent documentation",
    href: "#agent-documentation",
    variant: "accent",
  },
} satisfies Meta<typeof TextLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Accent: Story = {
  render: (args) => <InteractiveLink {...args} />,
  play: async ({ canvasElement }) => {
    const link = canvasElement.querySelector("a");
    assert(link instanceof HTMLAnchorElement, "text link renders as an anchor");
    await userEvent.click(link);

    const status = canvasElement.querySelector('[role="status"]');
    assert(status instanceof HTMLElement, "activation status renders");
    assert(
      status.textContent === "Documentation link activated.",
      "click behavior reaches the consumer handler",
    );
  },
};

export const Instruction: Story = {
  args: {
    children: "https://api.eliza.example/v1/agents/01JY5P4RTS8M7D6C5B4A3Z2X1W",
    href: "https://api.eliza.example/v1/agents/01JY5P4RTS8M7D6C5B4A3Z2X1W",
    variant: "instruction",
  },
  render: (args) => <TextLink {...args} />,
};
