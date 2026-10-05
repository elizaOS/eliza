/** Verifies the MCP editor offers no pricing and always submits a free listing (#22961). */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMcpRecord } from "./lib/api-types";

const mutationMocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./lib/mcp-mutations", () => ({
  useCreateMcp: () => ({
    isPending: false,
    mutateAsync: mutationMocks.create,
  }),
  useUpdateMcp: () => ({
    isPending: false,
    mutateAsync: mutationMocks.update,
  }),
}));

import { McpEditorDialog } from "./McpEditorDialog";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

const EDITING_MCP = {
  id: "mcp-1",
  name: "Weather Pro",
  slug: "weather-pro",
  description: "Real-time weather",
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

describe("McpEditorDialog free listings", () => {
  it("shows no price controls and submits an edit as free", async () => {
    mutationMocks.update.mockResolvedValueOnce({ mcp: EDITING_MCP });
    const onOpenChange = vi.fn();

    render(
      <McpEditorDialog
        open
        onOpenChange={onOpenChange}
        editing={EDITING_MCP}
      />,
    );

    expect(screen.getByTestId("mcp-free-listing-note")).toBeTruthy();
    expect(
      screen.queryByLabelText("Price per request (USD cloud credit)"),
    ).toBeNull();
    expect(screen.queryByLabelText("Pricing")).toBeNull();
    expect(screen.queryByLabelText("Enable x402 micropayments")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mutationMocks.update).toHaveBeenCalledOnce());
    const submitted = mutationMocks.update.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      mcpId: "mcp-1",
      input: { pricingType: "free" },
    });
    expect(submitted.input).not.toHaveProperty("priceUsd");
    expect(submitted.input).not.toHaveProperty("x402PriceUsd");
    expect(submitted.input).not.toHaveProperty("x402Enabled");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
