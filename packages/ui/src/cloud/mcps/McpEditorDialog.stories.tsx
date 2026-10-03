/** Storybook proof that the real MCP editor dialog offers only free listings (#22961). */

import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockAppProvider } from "../../storybook/mock-providers";
import { CloudI18nProvider } from "../shell/CloudI18nProvider";
import type { UserMcpRecord } from "./lib/api-types";
import { McpEditorDialog } from "./McpEditorDialog";

const EDITING_MCP = {
  id: "mcp-story-weather",
  name: "Weather Pro",
  slug: "weather-pro",
  description: "Real-time weather for agents",
  category: "utilities",
  external_endpoint: "https://mcp.example.com/weather",
  endpoint_path: "/mcp",
  pricing_type: "free",
  credit_unit: "USD",
  price_usd: "0",
  credits_per_request: "0",
  legacy_credits_per_request: "0",
  x402_price_usd: "0",
  x402_enabled: false,
  tools: [{ name: "get_weather", description: "Get weather" }],
  documentation_url: null,
} as unknown as UserMcpRecord;

const meta = {
  title: "Cloud/MCPs/EditorDialog",
  component: McpEditorDialog,
  parameters: { layout: "fullscreen" },
  decorators: [
    // MockAppProvider seeds the useAppSelector store; CloudI18nProvider backs
    // the dialog's useCloudT() (the cloud routes have their own i18n context).
    (Story) => (
      <MockAppProvider>
        <CloudI18nProvider initialLang="en">
          <Story />
        </CloudI18nProvider>
      </MockAppProvider>
    ),
  ],
} satisfies Meta<typeof McpEditorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FreeListing: Story = {
  render: () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });

    return (
      <QueryClientProvider client={queryClient}>
        <McpEditorDialog
          open
          onOpenChange={() => undefined}
          editing={EDITING_MCP}
        />
      </QueryClientProvider>
    );
  },
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument;
    if (!document.querySelector('[data-testid="mcp-free-listing-note"]')) {
      throw new Error("MCP editor did not explain that listings are free");
    }
    if (
      document.querySelector("#mcp-price-usd, #mcp-pricing, #mcp-x402-enabled")
    ) {
      throw new Error("MCP editor still renders a price control");
    }
  },
};
