import type { Meta, StoryObj } from "@storybook/react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "./input-group";

const meta = {
  title: "Primitives/InputGroup",
  component: InputGroup,
  tags: ["autodocs"],
} satisfies Meta<typeof InputGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <InputGroup className="w-80">
      <InputGroupAddon>
        <InputGroupText>https://</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput placeholder="your-agent.eliza.how" />
    </InputGroup>
  ),
};

export const WithButton: Story = {
  render: () => (
    <InputGroup className="w-80">
      <InputGroupInput placeholder="Search agents" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton variant="default" size="sm">
          Search
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
};

export const ErrorState: Story = {
  render: () => (
    <InputGroup className="w-80">
      <InputGroupAddon>
        <InputGroupText>@</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        aria-invalid="true"
        defaultValue="not-an-email"
        placeholder="you@example.com"
      />
    </InputGroup>
  ),
};

export const Textarea: Story = {
  render: () => (
    <InputGroup className="w-96">
      <InputGroupTextarea
        placeholder="Describe your agent's persona"
        rows={4}
      />
      <InputGroupAddon align="block-end">
        <InputGroupText>Markdown supported</InputGroupText>
        <InputGroupButton variant="default" size="sm" className="ml-auto">
          Save
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
};
