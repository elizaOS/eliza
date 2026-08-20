/** Storybook proof for canonical USD-denominated MCP pricing in the real editor dialog. */

import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  pricing_type: "credits",
  credit_unit: "USD",
  price_usd: "0.0125",
  credits_per_request: "1.25",
  legacy_credits_per_request: "1.25",
  x402_price_usd: "0.0001",
  x402_enabled: false,
  tools: [{ name: "get_weather", description: "Get weather" }],
  documentation_url: null,
} as unknown as UserMcpRecord;

const meta = {
  title: "Cloud/MCPs/EditorDialog",
  component: McpEditorDialog,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof McpEditorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CanonicalUsdPrice: Story = {
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
    const label = document.querySelector('label[for="mcp-price-usd"]');
    const input = document.querySelector<HTMLInputElement>("#mcp-price-usd");

    if (label?.textContent?.trim() !== "Price per request (USD cloud credit)") {
      throw new Error(
        "MCP editor did not render the canonical USD price label",
      );
    }
    if (input?.value !== "0.0125") {
      throw new Error(
        "MCP editor did not preserve the canonical fractional USD price",
      );
    }
  },
};
