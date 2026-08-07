/** Verifies ElizaWalletSection states through the package's configured test harness. */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaWalletSection } from "./eliza-wallet-section";

const translate = vi.hoisted(
  () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
);

vi.mock("../lib/i18n", () => ({
  useT: () => translate,
}));

vi.mock("../../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: vi.fn(),
}));

function response(body: unknown, ok = true): Response {
  return {
    ok,
    statusText: ok ? "OK" : "Service unavailable",
    json: async () => body,
  } as Response;
}

describe("ElizaWalletSection states", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("surfaces a required wallet request failure and offers a retry", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      return response({}, !url.endsWith("/addresses"));
    });

    render(<ElizaWalletSection agentId="agent-1" />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Couldn't load wallet details")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
  });

  it("explains when wallet addresses are not available yet", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/steward-status")) return response(null);
      return response({});
    });

    render(<ElizaWalletSection agentId="agent-1" />);

    expect(await screen.findByText("No wallet addresses yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Wallet addresses appear here after this agent finishes setting up.",
      ),
    ).toBeTruthy();
  });
});
