import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { ConnectorAccountPrivacy } from "../../api/client-agent";
import { TranslationProvider } from "../../state/TranslationProvider";
import { ConnectorAccountPrivacySelector } from "./ConnectorAccountPrivacySelector";

const meta = {
  title: "Connectors/ConnectorAccountPrivacySelector",
  component: ConnectorAccountPrivacySelector,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    value: {
      control: "select",
      options: ["owner_only", "team_visible", "semi_public", "public"],
    },
    disabled: { control: "boolean" },
    accountLabel: { control: "text" },
  },
  args: {
    value: "owner_only",
    disabled: false,
    accountLabel: "Acme Slack workspace",
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="max-w-md p-4">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof ConnectorAccountPrivacySelector>;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = async (_value: ConnectorAccountPrivacy) => {};

export const OwnerOnly: Story = {
  args: {
    value: "owner_only",
    onChange: noop,
  },
};

export const TeamVisible: Story = {
  args: {
    value: "team_visible",
    onChange: noop,
  },
};

export const Public: Story = {
  args: {
    value: "public",
    onChange: noop,
  },
};

export const Disabled: Story = {
  args: {
    value: "owner_only",
    disabled: true,
    onChange: noop,
  },
};

export const Interactive: Story = {
  args: { onChange: noop },
  render: (args) => {
    const [value, setValue] = useState<ConnectorAccountPrivacy>(
      args.value ?? "owner_only",
    );
    return (
      <ConnectorAccountPrivacySelector
        {...args}
        value={value}
        onChange={(next) => {
          setValue(next);
        }}
      />
    );
  },
};
