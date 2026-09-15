/** Storybook fixtures for the grouped Cloud Connectors settings treatment. */

import type { Meta, StoryObj } from "@storybook/react";
import { Bot, Calendar, Mail, Phone } from "lucide-react";
import {
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionStatusNotice,
  ConnectionStatusProvider,
} from "../../cloud-ui/components/connection-card";
import { TelegramIcon } from "../../cloud-ui/components/icons";
import {
  SettingsGroup,
  SettingsStack,
} from "../../components/settings/settings-layout";

function CloudConnectorSettingsFixture({ withError = false }) {
  return (
    <ConnectionStatusProvider>
      <SettingsStack className="mx-auto max-w-3xl">
        <ConnectionStatusNotice />
        <SettingsGroup
          title="Services"
          description="Email, calendar, phone, and business messaging."
        >
          <ConnectionCard
            name="Google Services"
            icon={<Mail />}
            description="Connect Gmail, Calendar, and Contacts."
            status="connected"
            statusBadge={<ConnectionConnectedBadge label="1 connected" />}
            connectedContent={<p>Google account connection details.</p>}
          />
          <ConnectionCard
            name="Microsoft Services"
            icon={<Calendar />}
            description="Connect Outlook Mail and Calendar."
            status="disconnected"
            setupContent={<p>Microsoft connection setup.</p>}
          />
          <ConnectionCard
            name="Twilio"
            icon={<Phone />}
            description="Connect SMS and voice services."
            status={withError ? "error" : "loading"}
            errorMessage="Twilio status could not be loaded."
            onRetry={() => {}}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Bot channels"
          description="Managed Discord and Telegram gateways."
        >
          <ConnectionCard
            name="Discord"
            icon={<Bot />}
            description="Connect a managed Discord bot."
            status="connected"
            statusBadge={<ConnectionConnectedBadge />}
            connectedContent={<p>Discord gateway connection details.</p>}
          />
          <ConnectionCard
            name="Telegram"
            icon={<TelegramIcon className="text-[#229ED9]" />}
            description="Connect a Telegram bot."
            status="disconnected"
            setupContent={<p>Telegram bot setup.</p>}
          />
        </SettingsGroup>
      </SettingsStack>
    </ConnectionStatusProvider>
  );
}

const meta = {
  title: "Cloud/Connectors/SettingsList",
  component: CloudConnectorSettingsFixture,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CloudConnectorSettingsFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const StatusError: Story = {
  args: { withError: true },
};
