/** Real Linux entry and typed desktop handoff; the native RPC is the test boundary. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NAVIGATE_VIEW_EVENT } from "../../events";

const boundary = vi.hoisted(() => ({
  request: vi.fn(),
  external: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock("../../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: boundary.request,
}));
vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
}));
vi.mock("../../bridge/storage-bridge", () => ({
  getStorageValue: boundary.get,
  setStorageValue: boundary.set,
}));
vi.mock("../../utils", () => ({ openExternalUrl: boundary.external }));
vi.mock("./BrowserSearchSettings", () => ({
  BrowserSearchSettings: () => <p>Explicit browser authorization</p>,
}));

import { LinuxChromiumBrowser } from "./LinuxChromiumBrowser";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  boundary.request.mockResolvedValue({ engine: "chromium", surface: "window" });
  boundary.get.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
function show() {
  return render(
    <LinuxChromiumBrowser
      workspace={<p>Existing app and wallet workspace</p>}
    />,
  );
}
it("opens typed websites in owned Chromium, leaving authorization explicit", async () => {
  show();
  fireEvent.change(screen.getByRole("textbox", { name: "Website or search" }), {
    target: { value: "example.org" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  await waitFor(() =>
    expect(boundary.request).toHaveBeenCalledWith({
      rpcMethod: "desktopOpenBrowser",
      ipcChannel: "desktop:openBrowser",
      params: { url: "https://example.org/" },
    }),
  );
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(screen.getByText("Explicit browser authorization")).toBeTruthy();
  expect(boundary.external).not.toHaveBeenCalled();
  expect(document.querySelector("iframe")).toBeNull();
});
it("keeps uncertain dispatch visible without fallback or a loaded-page claim", async () => {
  boundary.request.mockRejectedValue(new Error("Disconnected after dispatch"));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Facebook" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Disconnected after dispatch",
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(boundary.external).not.toHaveBeenCalled();
});
it("retains secondary workspace access without replaying initial website navigation", async () => {
  window.history.replaceState(
    null,
    "",
    "/browser?browse=https%3A%2F%2Fexample.org%2F",
  );
  show();
  await waitFor(() => expect(boundary.request).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "App and agent tabs" }));
  expect(screen.getByText("Existing app and wallet workspace")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Websites" }));
  expect(boundary.request).toHaveBeenCalledTimes(1);
  window.dispatchEvent(
    new CustomEvent(NAVIGATE_VIEW_EVENT, {
      detail: {
        viewId: "browser",
        viewPath: "/browser?browse=https%3A%2F%2Fexample.org%2Fnext",
      },
    }),
  );
  await waitFor(() => expect(boundary.request).toHaveBeenCalledTimes(2));
  expect(boundary.request.mock.lastCall?.[0].params.url).toBe(
    "https://example.org/next",
  );
});
it("opens the existing local password dialog and its typed browser handoff", async () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Passwords" }));
  expect(
    await screen.findByRole("dialog", { name: "Passwords & passkeys" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByLabelText("Password manager").hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Get browser extension" }),
  );
  await waitFor(() =>
    expect(boundary.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          url: "https://bitwarden.com/download/#downloads-web-browser",
        },
      }),
    ),
  );
});

it("keeps Android desktop-site guidance out of the Linux WhatsApp flow", async () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
  await screen.findByRole("status");
  expect(screen.queryByText(/If WhatsApp asks/)).toBeNull();
});
