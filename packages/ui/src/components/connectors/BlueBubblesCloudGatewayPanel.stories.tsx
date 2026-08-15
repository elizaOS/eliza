/** Storybook states for the BlueBubbles iPhone cloud-enrollment surface. */

import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import type { BlueBubblesCloudGatewayApi } from "./BlueBubblesCloudGatewayPanel";
import { BlueBubblesCloudGatewayPanel } from "./BlueBubblesCloudGatewayPanel";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "elizaCloudConnected") return true;
    if (prop === "setActionNotice") return () => {};
    return () => {};
  },
});

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
      <AppContext.Provider value={mockAppContext}>
        <div className="mx-auto max-w-2xl p-6">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BlueBubblesCloudGatewayPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedPhone: Story = {
  args: { api: storyApi, initialData: storyInitialData },
};
