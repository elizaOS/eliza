import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { ConnectorAccountRole } from "../../api/client-agent";
import { TranslationProvider } from "../../state/TranslationProvider";
import { ConnectorAccountPurposeSelector } from "./ConnectorAccountPurposeSelector";

const meta = {
  title: "Connectors/ConnectorAccountPurposeSelector",
  component: ConnectorAccountPurposeSelector,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    value: {
      control: "select",
      options: ["OWNER", "AGENT", "TEAM"],
    },
    disabled: { control: "boolean" },
    accountLabel: { control: "text" },
  },
  args: {
    value: "AGENT",
    disabled: false,
    accountLabel: "shaw@elizaos.ai",
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="flex w-[420px] items-center">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof ConnectorAccountPurposeSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentRole: Story = {
  render: (args) => {
    const [value, setValue] = useState<ConnectorAccountRole>(
      args.value ?? "AGENT",
    );
    return (
      <ConnectorAccountPurposeSelector
        {...args}
        value={value}
        onChange={(next) => {
          setValue(next);
        }}
      />
    );
  },
};

export const OwnerRole: Story = {
  args: { value: "OWNER" },
  render: (args) => {
    const [value, setValue] = useState<ConnectorAccountRole>(
      args.value ?? "OWNER",
    );
    return (
      <ConnectorAccountPurposeSelector
        {...args}
        value={value}
        onChange={(next) => {
          setValue(next);
        }}
      />
    );
  },
};

export const TeamRole: Story = {
  args: { value: "TEAM", accountLabel: "ops@team.example" },
  render: (args) => {
    const [value, setValue] = useState<ConnectorAccountRole>(
      args.value ?? "TEAM",
    );
    return (
      <ConnectorAccountPurposeSelector
        {...args}
        value={value}
        onChange={(next) => {
          setValue(next);
        }}
      />
    );
  },
};

export const Disabled: Story = {
  args: { value: "AGENT", disabled: true },
  render: (args) => (
    <ConnectorAccountPurposeSelector
      {...args}
      onChange={() => {
        /* no-op */
      }}
    />
  ),
};

export const AsyncOnChange: Story = {
  args: { value: "AGENT", accountLabel: "primary-bot" },
  render: (args) => {
    const [value, setValue] = useState<ConnectorAccountRole>(
      args.value ?? "AGENT",
    );
    return (
      <ConnectorAccountPurposeSelector
        {...args}
        value={value}
        onChange={async (next) => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          setValue(next);
        }}
      />
    );
  },
};
