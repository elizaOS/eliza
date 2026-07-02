// @vitest-environment jsdom

/**
 * WalletKeysSection — regression tests for the fetch-routing fix: every
 * secrets/wallet request must go through the shared `client` (which applies
 * the configured apiBase + injected auth token), never bare `fetch` against
 * the page origin. Also pins the 404 → "route not mounted" empty-state
 * mapping.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  rawRequest: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

import { WalletKeysSection } from "./WalletKeysSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WalletKeysSection — requests route through the shared client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clientMock.rawRequest.mockReset();
    // Any bare fetch here would hit the page origin without the client's
    // apiBase/token — the exact bug this guards against.
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("bare fetch must not be used"));
  });

  afterEach(() => {
    cleanup();
    fetchSpy.mockRestore();
  });

  it("loads the wallet inventory via client.rawRequest, not bare fetch", async () => {
    clientMock.rawRequest.mockResolvedValue(
      jsonResponse(200, {
        entries: [
          {
            key: "EVM_PRIVATE_KEY",
            label: "EVM_PRIVATE_KEY",
            category: "wallet",
            hasProfiles: false,
            kind: "secret",
          },
        ],
      }),
    );

    render(<WalletKeysSection />);

    await screen.findByTestId("wallet-keys-list");
    expect(clientMock.rawRequest).toHaveBeenCalledWith(
      "/api/secrets/inventory?category=wallet",
      undefined,
      { allowNonOk: true },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("wallet-keys-error")).toBeNull();
  });

  it("maps a 404 (secrets route not mounted) to the empty state, not an error", async () => {
    clientMock.rawRequest.mockResolvedValue(
      jsonResponse(404, { error: "not found" }),
    );

    render(<WalletKeysSection />);

    await screen.findByTestId("wallet-keys-empty");
    expect(screen.queryByTestId("wallet-keys-error")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces non-404 HTTP failures as an error banner", async () => {
    clientMock.rawRequest.mockResolvedValue(
      jsonResponse(500, { error: "boom" }),
    );

    render(<WalletKeysSection />);

    const banner = await screen.findByTestId("wallet-keys-error");
    expect(banner.textContent).toContain("HTTP 500");
    await waitFor(() =>
      expect(screen.getByTestId("wallet-keys-empty")).toBeTruthy(),
    );
  });
});
