import type { Meta, StoryObj } from "@storybook/react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion";

const meta = {
  title: "Primitives/Accordion",
  component: Accordion,
  tags: ["autodocs"],
  argTypes: {
    type: { control: "select", options: ["single", "multiple"] },
    collapsible: { control: "boolean" },
  },
  args: { type: "single", collapsible: true },
  render: (args) => (
    <Accordion {...args} className="w-80">
      <AccordionItem value="item-1">
        <AccordionTrigger>What is elizaOS?</AccordionTrigger>
        <AccordionContent>
          An open-source framework for building and deploying autonomous AI
          agents.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>Is it accessible?</AccordionTrigger>
        <AccordionContent>
          Yes. It is built on Radix UI primitives and follows the WAI-ARIA
          design pattern.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>Can it be styled?</AccordionTrigger>
        <AccordionContent>
          Yes. Every part accepts a className and animates on expand and
          collapse.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Collapsible: Story = {
  args: { type: "single", collapsible: true, defaultValue: "item-1" },
};
export const Multiple: Story = {
  args: { type: "multiple", defaultValue: ["item-1", "item-2"] },
};
