// @vitest-environment jsdom
//
// #11084 — the shell mounts ComputerUseApprovalOverlay before the auth probe
// resolves. Its SSE stream (and 1.5s polling fallback) must not issue a single
// request while the session is unauthenticated, and must start as soon as the
// shared auth snapshot flips to authenticated.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, openEventSourceMock, authMock, mockState } = vi.hoisted(
  () => ({
    clientMock: {
      getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
      getRestAuthToken: vi.fn(() => null),
      getComputerUseApprovals: vi.fn(async () => ({
        mode: "full_control",
        pendingCount: 0,
        pendingApprovals: [],
      })),
      respondToComputerUseApproval: vi.fn(),
    },
    openEventSourceMock: vi.fn(() => ({
      close: vi.fn(),
      onmessage: null,
      onerror: null,
    })),
    authMock: { authenticated: false },
    mockState: {
      setActionNotice: vi.fn(),
      t: (_key: string, vars?: { defaultValue?: string }) =>
        vars?.defaultValue ?? "",
    },
  }),
);

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../../utils/event-source", () => ({
  openEventSource: openEventSourceMock,
}));

vi.mock("../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(selector: (state: typeof mockState) => T): T =>
    selector(mockState),
}));

import { ComputerUseApprovalOverlay } from "./ComputerUseApprovalOverlay";

beforeEach(() => {
  clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
  clientMock.getRestAuthToken.mockReturnValue(null);
  clientMock.getComputerUseApprovals.mockClear();
  openEventSourceMock.mockClear();
  authMock.authenticated = false;
});

afterEach(() => {
  cleanup();
});

describe("ComputerUseApprovalOverlay auth gate (#11084)", () => {
  it("opens no SSE stream and issues no approval fetch while unauthenticated", async () => {
    render(<ComputerUseApprovalOverlay />);

    // Flush the mount effect + any microtask-deferred fetches.
    await Promise.resolve();
    await Promise.resolve();

    expect(openEventSourceMock).not.toHaveBeenCalled();
    expect(clientMock.getComputerUseApprovals).not.toHaveBeenCalled();
  });

  it("starts the SSE stream once the session flips to authenticated", async () => {
    const { rerender } = render(<ComputerUseApprovalOverlay />);
    await Promise.resolve();
    expect(openEventSourceMock).not.toHaveBeenCalled();

    authMock.authenticated = true;
    rerender(<ComputerUseApprovalOverlay />);

    await waitFor(() => {
      expect(openEventSourceMock).toHaveBeenCalledTimes(1);
    });
    expect(openEventSourceMock).toHaveBeenCalledWith(
      "http://127.0.0.1:31337/api/computer-use/approvals/stream",
    );
  });

  it("falls back to polling only after authentication (never before)", async () => {
    // Native IPC bases can't open EventSource — the overlay then polls.
    openEventSourceMock.mockReturnValue(null as never);

    const { rerender } = render(<ComputerUseApprovalOverlay />);
    await Promise.resolve();
    expect(clientMock.getComputerUseApprovals).not.toHaveBeenCalled();

    authMock.authenticated = true;
    rerender(<ComputerUseApprovalOverlay />);

    await waitFor(() => {
      expect(clientMock.getComputerUseApprovals).toHaveBeenCalledTimes(1);
    });
  });
});
