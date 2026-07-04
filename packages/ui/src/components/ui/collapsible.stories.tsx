/**
 * Storybook stories for the collapsible disclosure primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

const meta = {
  title: "Primitives/Collapsible",
  component: Collapsible,
  tags: ["autodocs"],
  argTypes: {
    defaultOpen: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: { defaultOpen: false, disabled: false },
  render: (args) => (
    <Collapsible {...args} className="w-80 space-y-2">
      <CollapsibleTrigger className="rounded-md border px-3 py-2 text-sm font-medium">
        Toggle plugin details
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 text-sm text-muted-foreground">
        <p>A plugin registers actions, providers, services, and evaluators.</p>
        <p>It exports a Plugin object from src/index.ts.</p>
      </CollapsibleContent>
    </Collapsible>
  ),
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const Disabled: Story = { args: { defaultOpen: true, disabled: true } };
