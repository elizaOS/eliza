/** Verifies that initial Vault failures remain actionable instead of spinning forever. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    vi.mocked(client.rawRequest).mockResolvedValue({
      ok: false,
      status: 429,
    } as Response);

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

    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading the vault" }),
    );
    await waitFor(() => {
      expect(client.rawRequest).toHaveBeenCalledTimes(16);
    });
  });
});
