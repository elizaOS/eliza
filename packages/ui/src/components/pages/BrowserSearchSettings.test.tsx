/** Verifies explicit profile selection and authority changes through the settings UI. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ fetch: vi.fn(), authority: "first" }));
vi.mock("../../state/agent-profiles", () => ({
  loadAgentProfileRegistry: () => ({ profiles: [], activeProfileId: null }),
}));
vi.mock("../../api", () => ({ client: { fetch: boundary.fetch } }));
vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  getActiveAgentAuthority: () => boundary.authority,
  useActiveAgentAuthority: () => boundary.authority,
}));

import { BrowserSearchSettings } from "./BrowserSearchSettings";

const connected = { targetId: "chromium-device", profileId: "profile-one" };
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  boundary.authority = "first";
});
it("persists the exact connected profile only after user selection and supports disabling", async () => {
  boundary.fetch.mockResolvedValueOnce({ connected, selected: null });
  render(<BrowserSearchSettings />);
  await screen.findByText("Connected profile: profile-one");
  expect(boundary.fetch).toHaveBeenCalledTimes(1);
  boundary.fetch.mockResolvedValueOnce({ connected, selected: connected });
  fireEvent.click(screen.getByRole("button", { name: "Use this browser" }));
  await screen.findByText("Using connected profile profile-one.");
  expect(boundary.fetch.mock.calls[1][1].body).toBe(
    JSON.stringify({ selected: connected }),
  );
  boundary.fetch.mockResolvedValueOnce({ connected, selected: null });
  fireEvent.click(
    screen.getByRole("button", { name: "Stop using this browser" }),
  );
  await screen.findByText("Connected profile: profile-one");
  expect(boundary.fetch.mock.calls[2][1].body).toBe(
    JSON.stringify({ selected: null }),
  );
});
it("does not reuse an old authority's asynchronous profile response", async () => {
  let finish: (value: unknown) => void = () => {};
  boundary.fetch.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<BrowserSearchSettings />);
  boundary.authority = "second";
  boundary.fetch.mockResolvedValueOnce({ connected: null, selected: null });
  view.rerender(<BrowserSearchSettings />);
  finish({ connected, selected: connected });
  await waitFor(() => expect(boundary.fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/profile-one/)).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Use this browser" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
