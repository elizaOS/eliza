/** Password-manager handoffs stay on the user's device even with a cloud agent selected. */
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
  open: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../../bridge/system-browser", () => ({
  openBrowserWebsite: boundary.open,
}));
vi.mock("../../bridge/storage-bridge", () => ({
  getStorageValue: boundary.get,
  setStorageValue: boundary.set,
}));
vi.mock("../../api", () => ({
  client: {
    getBaseUrl: () => "https://cloud-agent.example.test",
    fetch: boundary.fetch,
  },
}));

import { defaultPasswordProviderSettings } from "../../platform/password-provider-settings";
import { BrowserPasswordsDialog } from "./BrowserPasswordsDialog";

beforeEach(() => {
  vi.resetAllMocks();
  boundary.get.mockResolvedValue(null);
  boundary.open.mockResolvedValue(undefined);
  boundary.set.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function show() {
  render(<BrowserPasswordsDialog open onOpenChange={() => {}} />);
  await waitFor(() =>
    expect(
      screen.getByLabelText("Password manager").hasAttribute("disabled"),
    ).toBe(false),
  );
}

it("opens setup and a self-hosted web vault locally without calling the selected cloud agent", async () => {
  await show();
  fireEvent.click(
    screen.getByRole("button", { name: "Get browser extension" }),
  );
  await waitFor(() =>
    expect(boundary.open).toHaveBeenCalledWith(
      "https://bitwarden.com/download/#downloads-web-browser",
    ),
  );
  fireEvent.click(screen.getByText("Account & server settings"));
  fireEvent.change(screen.getByLabelText("Web vault address"), {
    target: { value: "https://vault.example.test/team/" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Remember setup" }));
  await screen.findByText("Setup saved on this device.");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Bitwarden web vault" }),
  );
  await waitFor(() =>
    expect(boundary.open).toHaveBeenLastCalledWith(
      "https://vault.example.test/team/",
    ),
  );
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(JSON.parse(boundary.set.mock.calls[0][1])).toEqual({
    ...defaultPasswordProviderSettings(),
    webVaults: {
      bitwarden: "https://vault.example.test/team/",
      "1password": "https://my.1password.com/",
    },
  });
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

it("switches providers without replacing a previously configured server", async () => {
  const stored = defaultPasswordProviderSettings();
  stored.webVaults.bitwarden = "https://vault.example.test/";
  stored.webVaults["1password"] = "https://our-team.1password.eu/";
  boundary.get.mockResolvedValue(JSON.stringify(stored));
  await show();
  fireEvent.change(screen.getByLabelText("Password manager"), {
    target: { value: "1password" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open 1Password web vault" }),
  );
  await waitFor(() =>
    expect(boundary.open).toHaveBeenLastCalledWith(
      "https://our-team.1password.eu/",
    ),
  );
  fireEvent.change(screen.getByLabelText("Password manager"), {
    target: { value: "bitwarden" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open Bitwarden web vault" }),
  );
  await waitFor(() =>
    expect(boundary.open).toHaveBeenLastCalledWith(
      "https://vault.example.test/",
    ),
  );
});

it("rejects unsafe destinations and reports failed local writes or launches", async () => {
  await show();
  fireEvent.click(screen.getByText("Account & server settings"));
  fireEvent.change(screen.getByLabelText("Web vault address"), {
    target: { value: "https://user:fixture@vault.example.test/" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open Bitwarden web vault" }),
  );
  await screen.findByRole("alert");
  expect(boundary.open).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Web vault address"), {
    target: { value: "https://vault.bitwarden.eu/" },
  });
  boundary.set.mockRejectedValue(new Error("fixture persistence failure"));
  fireEvent.click(screen.getByRole("button", { name: "Remember setup" }));
  await screen.findByText(/Could not save this setup/);
  expect(screen.queryByText("Setup saved on this device.")).toBeNull();
  boundary.open.mockRejectedValue(new Error("fixture browser failure"));
  fireEvent.click(
    screen.getByRole("button", { name: "Open Bitwarden web vault" }),
  );
  await screen.findByText(/Could not open the browser/);
  expect(boundary.open).toHaveBeenCalledOnce();
});

it("requires an explicit reset after saved settings cannot be read", async () => {
  boundary.get.mockResolvedValue("invalid JSON");
  render(<BrowserPasswordsDialog open onOpenChange={() => {}} />);
  await screen.findByRole("alert");
  expect(
    screen
      .getByRole("button", { name: "Open Bitwarden web vault" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reset local setup" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Open Bitwarden web vault" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(boundary.set).toHaveBeenCalledOnce();
});

it("provides the whole lifecycle through provider help without claiming a vault action happened", async () => {
  await show();
  for (const title of [
    "Generate & save",
    "Fill, view & use passkeys",
    "Change or reset a password",
    "Sync across devices",
    "Back up your vault",
    "Recover account access",
    "Lock & unlock",
  ]) {
    fireEvent.click(screen.getByText(title, { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: `${title} help` }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: `${title} help` })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  }
  expect(boundary.open).toHaveBeenCalledTimes(7);
  expect(
    boundary.open.mock.calls.every(([url]) =>
      url.startsWith("https://bitwarden.com/help/"),
    ),
  ).toBe(true);
  expect(boundary.set).not.toHaveBeenCalled();
  expect(screen.getByText(/Eliza does not read that status/)).toBeTruthy();
});
