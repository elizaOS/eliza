/**
 * Deterministic mocked-client UI tests proving initial Vault failures remain
 * actionable instead of spinning forever.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import { VaultWorkspace } from "./SecretsManagerSection";

vi.mock("../../api/client", () => ({
  client: {
    rawRequest: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VaultWorkspace initial load recovery", () => {
  it("surfaces the failed endpoint and offers a retry", async () => {
    vi.mocked(client.rawRequest).mockImplementation(
      async () => new Response(null, { status: 429 }),
    );

    render(
      <VaultWorkspace
        open
        onOpenChange={() => undefined}
        presentation="page"
      />,
    );

    expect(screen.getByText("Loading…")).toBeTruthy();
    const error = await screen.findByTestId("vault-modal-error");
    expect(error.textContent).toContain("backends: HTTP 429");
    expect(screen.queryByText("Loading…")).toBeNull();

    vi.mocked(client.rawRequest).mockImplementation(async (path) => {
      switch (path) {
        case "/api/secrets/manager/backends":
          return Response.json({
            backends: [
              {
                id: "in-house",
                label: "Local encrypted vault",
                available: true,
                signedIn: true,
              },
            ],
          });
        case "/api/secrets/manager/preferences":
          return Response.json({ preferences: { enabled: ["in-house"] } });
        case "/api/secrets/manager/install/methods":
          return Response.json({ methods: {} });
        case "/api/secrets/inventory":
          return Response.json({ entries: [], securityFindings: [] });
        case "/api/secrets/routing":
          return Response.json({ config: { rules: [] } });
        case "/api/secrets/manager/protection":
        case "/api/agents":
        case "/api/apps":
          return new Response(null, { status: 404 });
        default:
          throw new Error(`Unexpected vault request: ${path}`);
      }
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading the vault" }),
    );
    expect(
      await screen.findByRole("tab", { name: "Overview Vault section" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("vault-modal-error")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
