/** Storybook states for the BlueBubbles iPhone cloud-enrollment surface. */

import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProvider } from "../../storybook/mock-providers";
import type { BlueBubblesCloudGatewayApi } from "./BlueBubblesCloudGatewayPanel";
import { BlueBubblesCloudGatewayPanel } from "./BlueBubblesCloudGatewayPanel";

const storyApi: BlueBubblesCloudGatewayApi = {
  async listCloudBlueBubblesGateways() {
    return {
      success: true,
      data: {
        gateways: [
          {
            id: "gateway-1",
            bridgeId: "bb-office",
            phoneNumber: "+14155550123",
            friendlyName: "Office iPhone",
            routingMode: "sender-owned",
            agentId: null,
            userId: "user-1",
            lastSeenAt: "2026-08-05T10:05:00.000Z",
            status: "connected",
          },
        ],
      },
    };
  },
  async registerCloudBlueBubblesGateway(request) {
    return {
      success: true,
      data: {
        id: "gateway-new",
        bridgeId: "bb-new",
        phoneNumber: request.phoneNumber,
        routingMode: "sender-owned",
        agentId: null,
        webhookUrl: "https://api.eliza.app/api/webhooks/bluebubbles/bb-new",
        token: "bbg_one_time_example",
        relayEnvironment: {
          ELIZA_CLOUD_BLUEBUBBLES_URL:
            "https://api.eliza.app/api/webhooks/bluebubbles/bb-new",
          BLUEBUBBLES_BRIDGE_ID: "bb-new",
          BLUEBUBBLES_GATEWAY_TOKEN: "bbg_one_time_example",
          BLUEBUBBLES_GATEWAY_PHONE_NUMBER: request.phoneNumber,
        },
      },
    };
  },
  async revokeCloudBlueBubblesGateway() {
    return { success: true };
  },
};

const storyInitialData = {
  gateways: [
    {
      id: "gateway-1",
      bridgeId: "bb-office",
      phoneNumber: "+14155550123",
      friendlyName: "Office iPhone",
      routingMode: "sender-owned" as const,
      agentId: null,
      userId: "user-1",
      lastSeenAt: "2026-08-05T10:05:00.000Z",
      status: "connected" as const,
    },
  ],
};

const meta = {
  title: "Connectors/BlueBubblesCloudGatewayPanel",
  component: BlueBubblesCloudGatewayPanel,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MockAppProvider value={{ elizaCloudConnected: true }}>
        <div className="mx-auto max-w-2xl p-6">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BlueBubblesCloudGatewayPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedPhone: Story = {
  args: { api: storyApi, initialData: storyInitialData },
};
