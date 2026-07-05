// @vitest-environment jsdom

/**
 * WalletKeysSection — regression tests for the fetch-routing fix: every
 * secrets/wallet request must go through the shared `client` (which applies
 * the configured apiBase + injected auth token), never bare `fetch` against
 * the page origin. Also pins the 404 => "route not mounted" empty-state
 * mapping, and (#13453) the plain-language HTTP-error mapping the wallet
 * keys panel surfaces instead of a raw `HTTP 502` / `HTTP 500` banner.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  rawRequest: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

import { RoleProvider } from "../../hooks/useRole";
import { WalletKeysSection } from "./WalletKeysSection";

function renderAsOwner() {
  // WalletKeysSection is gated behind `<RoleGate minRole="OWNER">` (#12087
  // Item 24). Tests targeting the panel body itself have to seed the role
  // provider with OWNER, otherwise every render hits the owner-only fallback
  // and the tests are asserting the wrong element.
  return render(
    // `role` here is `RoleGateRole` (OWNER/ADMIN/...), not an ARIA role attribute.
    // biome-ignore lint/a11y/useValidAriaRole: RoleProvider.role is a canonical role tier, not an ARIA role.
    <RoleProvider role="OWNER">
      <WalletKeysSection />
    </RoleProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WalletKeysSection - requests route through the shared client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clientMock.rawRequest.mockReset();
    // Any bare fetch here would hit the page origin without the client's
    // apiBase/token, the exact bug this guards against.
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

    renderAsOwner();

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

    renderAsOwner();

    await screen.findByTestId("wallet-keys-empty");
    expect(screen.queryByTestId("wallet-keys-error")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("WalletKeysSection - plain-language HTTP error copy (#13453)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clientMock.rawRequest.mockReset();
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("bare fetch must not be used"));
  });

  afterEach(() => {
    cleanup();
    fetchSpy.mockRestore();
  });

  it("shows a recovery message on a 500 (vault service down), not a bare HTTP status", async () => {
    clientMock.rawRequest.mockResolvedValue(
      jsonResponse(500, { error: "boom" }),
    );

    renderAsOwner();

    const banner = await screen.findByTestId("wallet-keys-error");
    // Plain-language recovery copy first, raw status still parenthesized so
    // developers can diagnose without the user reading `HTTP 500` alone.
    expect(banner.textContent).toContain("vault service is unavailable");
    expect(banner.textContent).toContain("Try again shortly");
    expect(banner.textContent).toContain("HTTP 500");
    // Must not read as the terse pre-fix "HTTP 500" banner (no recovery copy).
    expect(banner.textContent?.trim()).not.toBe("HTTP 500");
    await waitFor(() =>
      expect(screen.getByTestId("wallet-keys-empty")).toBeTruthy(),
    );
  });

  it("shows a bad-gateway state on a 502 too (audit's screenshot case)", async () => {
    clientMock.rawRequest.mockResolvedValue(
      jsonResponse(502, { error: "bad gateway" }),
    );

    renderAsOwner();

    const banner = await screen.findByTestId("wallet-keys-error");
    expect(banner.textContent).toContain("vault service is unavailable");
    expect(banner.textContent).toContain("HTTP 502");
  });

  it("shows a permission message on 403, not a bare HTTP status", async () => {
    clientMock.rawRequest.mockResolvedValue(
      jsonResponse(403, { error: "forbidden" }),
    );

    renderAsOwner();

    const banner = await screen.findByTestId("wallet-keys-error");
    expect(banner.textContent).toContain("do not have permission");
    expect(banner.textContent).toContain("HTTP 403");
  });

  it("shows a rate-limit message on 429", async () => {
    clientMock.rawRequest.mockResolvedValue(
      jsonResponse(429, { error: "too many" }),
    );

    renderAsOwner();

    const banner = await screen.findByTestId("wallet-keys-error");
    expect(banner.textContent).toContain("Too many requests");
    expect(banner.textContent).toContain("HTTP 429");
  });
});
