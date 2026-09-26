/** Exercises real browser-launch UI behavior with a controlled native boundary, including navigation errors and credential handoff. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAVIGATE_VIEW_EVENT } from "../../events";

vi.mock("./BrowserSearchSettings", () => ({
  BrowserSearchSettings: () => null,
}));

const native = vi.hoisted(() => ({ openBrowser: vi.fn(), open: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  registerPlugin: (name: string) =>
    name === "CredentialManager"
      ? { open: native.open }
      : { openBrowser: native.openBrowser },
}));
vi.mock("../../hooks/useAndroidChromiumAgentControl", () => ({
  useAndroidChromiumAgentControl: () => undefined,
}));

import {
  AndroidChromiumBrowser,
  chromiumAddress,
} from "./AndroidChromiumBrowser";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("Android full browser entry", () => {
  it("opens a real website only through the native full-browser boundary", async () => {
    native.openBrowser.mockResolvedValue({
      packageName: "org.chromium.chrome",
      engine: "chromium",
      surface: "custom-tab",
    });
    render(<AndroidChromiumBrowser />);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Website or search" }),
      { target: { value: "example.org" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() =>
      expect(native.openBrowser).toHaveBeenCalledWith({
        url: "https://example.org/",
      }),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("shows Android desktop-site guidance only after WhatsApp opens and clears it for other sites", async () => {
    native.openBrowser.mockResolvedValue({});
    render(<AndroidChromiumBrowser />);
    expect(screen.queryByText(/If WhatsApp asks/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "choose Desktop site. Chromium remembers this setting for WhatsApp.",
    );
    expect(native.openBrowser).toHaveBeenCalledWith({
      url: "https://web.whatsapp.com/",
    });
    for (const name of ["Google", "Facebook", "Instagram"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      await screen.findByRole("status");
      expect(screen.queryByText(/If WhatsApp asks/)).toBeNull();
    }
  });

  it("does not claim a WhatsApp handoff succeeded when the native browser rejects it", async () => {
    native.openBrowser.mockRejectedValue(new Error("Browser unavailable"));
    render(<AndroidChromiumBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(/If WhatsApp asks/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows unavailable errors without pretending the website loaded", async () => {
    native.openBrowser.mockRejectedValue(
      new Error("Chromium is not installed."),
    );
    render(<AndroidChromiumBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Chromium is not installed",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens the native password manager setup instead of retrieving secrets", async () => {
    native.open.mockResolvedValue(undefined);
    render(<AndroidChromiumBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Passwords" }));
    await waitFor(() => expect(native.open).toHaveBeenCalledOnce());
    expect(native.openBrowser).not.toHaveBeenCalled();
  });

  it("handles authenticated shell navigation while the browser panel is mounted", async () => {
    native.openBrowser.mockResolvedValue({});
    render(<AndroidChromiumBrowser />);
    window.dispatchEvent(
      new CustomEvent(NAVIGATE_VIEW_EVENT, {
        detail: {
          viewId: "browser",
          viewPath: "/browser?browse=https%3A%2F%2Fexample.org%2Fnext",
        },
      }),
    );
    await waitFor(() =>
      expect(native.openBrowser).toHaveBeenCalledWith({
        url: "https://example.org/next",
      }),
    );
  });

  it("encodes searches and rejects executable or credential-bearing URLs", () => {
    expect(chromiumAddress("tea & coffee")).toBe(
      "https://www.google.com/search?q=tea%20%26%20coffee",
    );
    for (const input of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:password@example.org/",
    ]) {
      expect(() => chromiumAddress(input)).toThrow();
    }
  });
});
