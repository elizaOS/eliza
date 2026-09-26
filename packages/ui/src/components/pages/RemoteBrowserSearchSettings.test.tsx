/** Hosted-agent browser admission binds explicit consent to one session/profile and agent authority. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  fetch: vi.fn(),
  directory: vi.fn(),
  authority: "cloud-one",
}));
vi.mock("../../api", () => ({ client: { fetch: boundary.fetch } }));
vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  getActiveAgentAuthority: () => boundary.authority,
}));
vi.mock("../../api/remote-control-cloud-default", () => ({
  createDefaultRemoteControlCloudClient: () => ({
    listHosts: boundary.directory,
  }),
  getDefaultRemoteControlCloudConnection: () => ({
    baseUrl: "https://cloud.example.invalid",
    authToken: "fixture-owner-token",
  }),
}));
vi.mock("../../platform/remote-target", () => ({
  supportsNativeRemoteTarget: () => false,
}));

import { RemoteBrowserSearchSettings } from "./RemoteBrowserSearchSettings";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  boundary.authority = "cloud-one";
});
function setup() {
  boundary.fetch.mockResolvedValueOnce({ configured: false });
  boundary.directory.mockResolvedValue({
    hosts: [
      {
        id: "host-phone",
        deviceId: "device-phone",
        displayName: "My phone",
        status: "active",
      },
    ],
  });
  return render(<RemoteBrowserSearchSettings authority="cloud-one" />);
}
it("pairs the owner-selected device and requires exact profile consent before connecting", async () => {
  setup();
  await screen.findByRole("option", { name: "My phone (active)" });
  fireEvent.change(screen.getByLabelText("Browser device"), {
    target: { value: "device-phone" },
  });
  fireEvent.change(screen.getByLabelText("Chromium profile"), {
    target: { value: "phone-profile" },
  });
  boundary.fetch.mockResolvedValueOnce({
    code: "123456",
    sessionId: "session",
    profileId: "phone-profile",
    deviceId: "device-phone",
    controller: { displayName: "My agent", keyId: "controller-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Pair this browser" }));
  await screen.findByText("Pairing code: 123456");
  const pairCall = boundary.fetch.mock.calls[1];
  expect(pairCall[0]).toBe("/api/remote-browser/pair");
  expect(JSON.parse(pairCall[1].body)).toEqual({
    apiBaseUrl: "https://cloud.example.invalid",
    authToken: "fixture-owner-token",
    deviceId: "device-phone",
    profileId: "phone-profile",
    preferred: true,
  });
  const confirm = screen.getByRole("button", {
    name: "Device approved — connect browser",
  });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Allow this agent to use profile/ }),
  );
  boundary.fetch.mockResolvedValueOnce({
    configured: true,
    active: true,
    deviceId: "device-phone",
    profileId: "phone-profile",
    sessionId: "session",
  });
  fireEvent.click(confirm);
  await screen.findByText("Using profile phone-profile on My phone.");
  expect(JSON.parse(boundary.fetch.mock.calls[2][1].body)).toEqual({
    sessionId: "session",
    profileId: "phone-profile",
    authorizeBrowser: true,
  });
  boundary.fetch.mockResolvedValueOnce({ revoked: true });
  fireEvent.click(
    screen.getByRole("button", { name: "Revoke browser access" }),
  );
  await screen.findByRole("button", { name: "Pair this browser" });
  expect(boundary.fetch.mock.calls[3][0]).toBe("/api/remote-browser/revoke");
});
it("does not send a stale pairing mutation after selected agent authority changes", async () => {
  setup();
  await screen.findByRole("option", { name: "My phone (active)" });
  fireEvent.change(screen.getByLabelText("Browser device"), {
    target: { value: "device-phone" },
  });
  fireEvent.change(screen.getByLabelText("Chromium profile"), {
    target: { value: "phone-profile" },
  });
  boundary.authority = "other-cloud-agent";
  fireEvent.click(screen.getByRole("button", { name: "Pair this browser" }));
  expect(boundary.fetch).toHaveBeenCalledTimes(1);
});
it("keeps failed device approval pending without retry or success claim", async () => {
  boundary.fetch.mockResolvedValueOnce({
    configured: true,
    active: false,
    sessionId: "session",
    profileId: "profile",
  });
  boundary.directory.mockResolvedValue({ hosts: [] });
  render(<RemoteBrowserSearchSettings authority="cloud-one" />);
  await screen.findByText("Session: session");
  fireEvent.click(screen.getByRole("checkbox"));
  boundary.fetch.mockRejectedValueOnce(new Error("private server details"));
  fireEvent.click(
    screen.getByRole("button", { name: "Device approved — connect browser" }),
  );
  await screen.findByRole("alert");
  expect(screen.queryByText(/private server details/)).toBeNull();
  await waitFor(() => expect(boundary.fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/Using profile/)).toBeNull();
});

it("does not carry consent across a refreshed session or profile", async () => {
  boundary.fetch.mockResolvedValueOnce({
    configured: true,
    active: false,
    sessionId: "first",
    profileId: "first-profile",
  });
  boundary.directory.mockResolvedValue({ hosts: [] });
  render(<RemoteBrowserSearchSettings authority="cloud-one" />);
  await screen.findByText("Session: first");
  fireEvent.click(screen.getByRole("checkbox"));
  boundary.fetch.mockResolvedValueOnce({
    configured: true,
    active: false,
    sessionId: "second",
    profileId: "second-profile",
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await screen.findByText("Session: second");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  expect(
    screen
      .getByRole("button", { name: "Device approved — connect browser" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
