/** Existing Vault rows use the same local provider destination as Browser Passwords. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  fetch: vi.fn(),
  get: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ client: { fetch: boundary.fetch } }));
vi.mock("../../../bridge/storage-bridge", () => ({
  getStorageValue: boundary.get,
  setStorageValue: vi.fn(),
}));
vi.mock("../../../bridge/system-browser", () => ({
  openBrowserWebsite: boundary.open,
}));

import { LoginsTab } from "./LoginsTab";

beforeEach(() => {
  vi.resetAllMocks();
  boundary.fetch.mockResolvedValue({
    logins: [
      {
        source: "bitwarden",
        identifier: "bw-fixture",
        domain: null,
        username: "fixture",
        title: "Fixture account",
        updatedAt: 0,
      },
      {
        source: "1password",
        identifier: "op-fixture",
        domain: null,
        username: "fixture",
        title: "Second account",
        updatedAt: 0,
      },
    ],
  });
  boundary.get.mockResolvedValue(
    JSON.stringify({
      provider: "bitwarden",
      webVaults: {
        bitwarden: "https://vault.example.test/team/",
        "1password": "https://our-team.1password.eu/",
      },
    }),
  );
  boundary.open.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("opens the configured self-hosted and regional vaults without revealing a login", async () => {
  render(<LoginsTab />);
  fireEvent.click(
    await screen.findByRole("button", { name: "View in Bitwarden" }),
  );
  await waitFor(() =>
    expect(boundary.open).toHaveBeenCalledWith(
      "https://vault.example.test/team/",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "View in 1Password" }));
  await waitFor(() =>
    expect(boundary.open).toHaveBeenCalledWith(
      "https://our-team.1password.eu/",
    ),
  );
  expect(boundary.fetch).toHaveBeenCalledExactlyOnceWith("/api/secrets/logins");
});

it("shows a destination failure without falling back to a different provider server", async () => {
  boundary.get.mockResolvedValue("broken");
  render(<LoginsTab />);
  fireEvent.click(
    await screen.findByRole("button", { name: "View in Bitwarden" }),
  );
  await screen.findByText(/Could not open your provider/);
  expect(boundary.open).not.toHaveBeenCalled();
});
