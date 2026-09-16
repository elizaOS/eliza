/** Story coverage for the shared connector capability tile molecule. */

import type { Meta, StoryObj } from "@storybook/react";
import { Calendar, Mail } from "lucide-react";
import { ConnectionCapabilityTile } from "./connection-capability-tile";

const meta = {
  title: "Cloud/Connectors/ConnectionCapabilityTile",
  component: ConnectionCapabilityTile,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="theme-cloud bg-bg p-4 text-txt">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConnectionCapabilityTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MailCapability: Story = {
  args: {
    description: "Send and read emails",
    icon: <Mail className="size-6 text-accent" aria-hidden />,
    title: "Mail",
  },
  decorators: [
    (Story) => (
      <div className="w-40">
        <Story />
      </div>
    ),
  ],
};

export const CalendarCapability: Story = {
  args: {
    description: "Manage events",
    icon: <Calendar className="size-6 text-muted" aria-hidden />,
    title: "Calendar",
  },
  decorators: [
    (Story) => (
      <div className="w-40">
        <Story />
      </div>
    ),
  ],
};

export const GoogleCapabilityGrid: Story = {
  args: MailCapability.args,
  render: () => (
    <div className="grid w-[320px] grid-cols-3 gap-3">
      <ConnectionCapabilityTile
        icon={<Mail className="size-6 text-accent" aria-hidden />}
        title="Gmail"
        description="Send and read emails"
      />
      <ConnectionCapabilityTile
        icon={<Calendar className="size-6 text-txt" aria-hidden />}
        title="Calendar"
        description="Manage events across multiple shared calendars"
      />
      <ConnectionCapabilityTile
        icon={<Mail className="size-6 text-accent" aria-hidden />}
        title="Contacts"
        description="Access contacts"
      />
    </div>
  ),
};

export const MicrosoftCapabilityGrid: Story = {
  args: CalendarCapability.args,
  render: () => (
    <div className="grid w-[320px] grid-cols-2 gap-3">
      <ConnectionCapabilityTile
        icon={<Mail className="size-6 text-muted" aria-hidden />}
        title="Outlook"
        description="Send and read emails"
      />
      <ConnectionCapabilityTile
        icon={<Calendar className="size-6 text-muted" aria-hidden />}
        title="Calendar"
        description="Manage events"
      />
    </div>
  ),
};
