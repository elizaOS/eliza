// @vitest-environment jsdom
/** Real production cards/dialogs; session and OAuth HTTP boundaries are synthetic. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GoogleConnection } from "../google-connection";

const io = vi.hoisted(() => ({
  accountId: "owner-a",
  api: vi.fn(),
  refetch: vi.fn(async () => {}),
  legacyDisconnect: vi.fn(),
  legacy: {
    id: "legacy-owned",
    status: "active",
    email: "legacy@example.test",
    scopes: [],
  },
}));
vi.mock("../../lib/api-client", () => ({ api: io.api }));
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: io.accountId },
  }),
}));
vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options: { defaultValue: string }) =>
    options.defaultValue,
}));
vi.mock("../oauth-connection", () => ({
  useOAuthConnections: () => ({
    connections: [io.legacy],
    activeConnections: [io.legacy],
    isLoading: false,
    isError: false,
    isConnecting: false,
    disconnectingId: null,
    connect: vi.fn(),
    disconnect: io.legacyDisconnect,
    refetch: io.refetch,
  }),
}));
const purpose = "personal_google_context_v1";
const statusUrl = `/api/v1/eliza/google/status?side=owner&purpose=${purpose}`;
const selected = {
  purpose,
  selectedConnectionId: "selected-owned",
  status: {
    connected: true,
    configured: true,
    reason: "connected",
    connectionId: "selected-owned",
    identity: { email: "personal@example.test" },
    grantedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  },
};
const disconnected = { purpose, selectedConnectionId: null, status: null };
beforeEach(() => {
  io.accountId = "owner-a";
  io.api.mockReset();
  io.refetch.mockClear();
  io.legacyDisconnect.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network in Google UI regression");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows selected personal consent separately and disconnects only that grant through the real dialog", async () => {
  let connected = true;
  io.api.mockImplementation(async (url: string) => {
    if (url === statusUrl) return connected ? selected : disconnected;
    if (url === "/api/v1/eliza/google/disconnect") {
      connected = false;
      return {};
    }
    throw new Error("Unexpected Google UI operation");
  });
  render(<GoogleConnection />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Manage Google for personal chat",
    }),
  );
  expect(await screen.findByText("personal@example.test")).toBeTruthy();
  expect(
    screen.getByText(
      /Requested content is processed by Eliza’s configured AI providers/,
    ),
  ).toBeTruthy();
  const statusRequestsBeforeDisconnect = io.api.mock.calls.filter(
    ([url]) => url === statusUrl,
  ).length;
  fireEvent.click(
    screen.getByRole("button", { name: "Disconnect personal context" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Disconnect personal context" }),
  );
  await waitFor(() => expect(io.refetch).toHaveBeenCalledTimes(1));
  expect(io.api).toHaveBeenCalledWith(
    "/api/v1/eliza/google/disconnect",
    expect.objectContaining({
      method: "POST",
      json: { side: "owner", connectionId: "selected-owned" },
    }),
  );
  expect(io.legacyDisconnect).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Manage Google Services" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      io.api.mock.calls.filter(([url]) => url === statusUrl).length,
    ).toBeGreaterThan(statusRequestsBeforeDisconnect),
  );
}, 30_000);

it("aborts old-account status and ignores its late result after an account switch", async () => {
  let oldSignal: AbortSignal | undefined;
  let resolveOld: ((value: typeof selected) => void) | undefined;
  io.api
    .mockImplementationOnce(
      (_url: string, options: { signal: AbortSignal }) => {
        oldSignal = options.signal;
        return new Promise<typeof selected>((resolve) => {
          resolveOld = resolve;
        });
      },
    )
    .mockResolvedValue(disconnected);
  const view = render(<GoogleConnection />);
  await waitFor(() => expect(oldSignal).toBeDefined());
  io.accountId = "owner-b";
  view.rerender(<GoogleConnection />);
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolveOld?.(selected));
  await screen.findByRole("button", {
    name: "Set up Google for personal chat",
  });
  expect(screen.queryByText("personal@example.test")).toBeNull();
}, 30_000);

it("sends the disclosed owner purpose on connect and shows recovery without navigating on failure", async () => {
  io.api.mockImplementation(async (url: string) => {
    if (url === statusUrl) return disconnected;
    throw new Error("Synthetic OAuth initiation failure");
  });
  render(<GoogleConnection />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Set up Google for personal chat",
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect personal context" }),
  );
  expect(
    await screen.findByText(
      "Couldn’t start the Google connection. Please try again.",
    ),
  ).toBeTruthy();
  expect(io.api).toHaveBeenCalledWith(
    "/api/v1/eliza/google/connect/initiate",
    expect.objectContaining({
      method: "POST",
      json: { side: "owner", purpose },
    }),
  );
}, 30_000);
