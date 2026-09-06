/** Shows owner registration controls through the real SDK and an explicit empty HTTP fixture. */
import { CloudApiClient } from "@elizaos/cloud-sdk";
import { AppDelegationManagementClient } from "@elizaos/cloud-sdk/app-delegation";
import type { Meta, StoryObj } from "@storybook/react";
import { AppDelegationSettings } from "./app-delegation-settings";

const client = new AppDelegationManagementClient(
  new CloudApiClient("https://fixture.example/api/v1", undefined, {
    fetchImpl: async () => Response.json({ success: true, data: [] }),
  }),
  "app-1",
);
const meta = {
  title: "Cloud/Apps/Client registrations",
  component: AppDelegationSettings,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto h-dvh w-full max-w-3xl overflow-y-auto p-6">
        <Story />
      </div>
    ),
  ],
  args: { client, appName: "Field Notes" },
} satisfies Meta<typeof AppDelegationSettings>;
export default meta;
export const Empty: StoryObj<typeof meta> = {};
