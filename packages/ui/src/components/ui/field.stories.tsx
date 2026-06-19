import type { Meta, StoryObj } from "@storybook/react";
import { Field, FieldDescription, FieldLabel, FieldMessage } from "./field";
import { Input } from "./input";

const meta = {
  title: "Primitives/Field",
  component: Field,
  tags: ["autodocs"],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Field {...args}>
      <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
      <Input id="agent-name" placeholder="Eliza" />
    </Field>
  ),
};

export const WithDescription: Story = {
  render: (args) => (
    <Field {...args}>
      <FieldLabel htmlFor="api-base">API base URL</FieldLabel>
      <Input id="api-base" placeholder="https://api.example.com" />
      <FieldDescription>
        The endpoint your agent uses for model requests.
      </FieldDescription>
    </Field>
  ),
};

export const FormLabel: Story = {
  render: (args) => (
    <Field {...args}>
      <FieldLabel htmlFor="webhook-url" variant="form">
        Webhook URL
      </FieldLabel>
      <Input id="webhook-url" placeholder="https://hooks.example.com/eliza" />
    </Field>
  ),
};

export const ErrorState: Story = {
  render: (args) => (
    <Field {...args}>
      <FieldLabel htmlFor="api-token">API token</FieldLabel>
      <Input id="api-token" defaultValue="invalid-token" />
      <FieldMessage tone="danger">
        This token was rejected by the provider.
      </FieldMessage>
    </Field>
  ),
};

export const SuccessState: Story = {
  render: (args) => (
    <Field {...args}>
      <FieldLabel htmlFor="api-token-ok">API token</FieldLabel>
      <Input id="api-token-ok" defaultValue="sk-live-2f9c..." />
      <FieldMessage tone="success">Token verified.</FieldMessage>
    </Field>
  ),
};
