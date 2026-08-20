/** Verifies canonical USD MCP pricing through the rendered editor boundary. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("McpEditorDialog canonical credit pricing", () => {
  it("renders and submits the server-projected USD price, not legacy points", async () => {
    mutationMocks.update.mockResolvedValueOnce({ mcp: EDITING_MCP });
    const onOpenChange = vi.fn();

    render(
      <McpEditorDialog
        open
        onOpenChange={onOpenChange}
        editing={EDITING_MCP}
      />,
    );

    const priceInput = screen.getByLabelText(
      "Price per request (USD cloud credit)",
    ) as HTMLInputElement;
    expect(priceInput.value).toBe("0.0125");

    fireEvent.change(priceInput, { target: { value: "0.025" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mutationMocks.update).toHaveBeenCalledOnce());
    const submitted = mutationMocks.update.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      mcpId: "mcp-1",
      input: { priceUsd: 0.025 },
    });
    expect(submitted.input).not.toHaveProperty("creditsPerRequest");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("converts a mixed-version legacy point price instead of silently defaulting", () => {
    const legacyRecord = {
      ...EDITING_MCP,
      price_usd: undefined,
      credits_per_request: "250",
      legacy_credits_per_request: undefined,
    } as unknown as UserMcpRecord;

    render(
      <McpEditorDialog open onOpenChange={vi.fn()} editing={legacyRecord} />,
    );

    expect(
      (
        screen.getByLabelText(
          "Price per request (USD cloud credit)",
        ) as HTMLInputElement
      ).value,
    ).toBe("2.5");
  });
});
