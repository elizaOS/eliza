// @vitest-environment jsdom
//
// Android WebView / WebKit throw "Failed to construct 'URL': Invalid URL" when
// resolving a relative path against a non-special-scheme base such as the
// on-device native IPC base `eliza-local-agent://ipc`. (Node/jsdom's WHATWG URL
// accepts that resolution, which is why the crash never reproduced in unit
// tests.) The overlay used to build its SSE URL with an unguarded
// `new URL(path, baseUrl)` at effect time, which crashed the entire app shell
// at boot on Android on-device builds. This suite emulates the WebView parser
// and pins the degrade-to-polling behavior.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, openEventSourceMock, mockState } = vi.hoisted(() => ({
  clientMock: {
    getBaseUrl: vi.fn(() => "eliza-local-agent://ipc"),
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
  mockState: {
    setActionNotice: vi.fn(),
    t: (_key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? "",
  },
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../../utils/event-source", () => ({
  openEventSource: openEventSourceMock,
}));

vi.mock("../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => true,
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(selector: (state: typeof mockState) => T): T =>
    selector(mockState),
}));

import { ComputerUseApprovalOverlay } from "./ComputerUseApprovalOverlay";

const RealURL = globalThis.URL;

/** WebView-like URL: throws when the base is not an http(s)/file/ws special scheme. */
class WebViewLikeURL extends RealURL {
  constructor(url: string | URL, base?: string | URL) {
    if (
      base !== undefined &&
      !/^(?:https?|file|ws|wss|ftp):/i.test(String(base))
    ) {
      throw new TypeError("Failed to construct 'URL': Invalid URL");
    }
    super(url, base);
  }
}

beforeEach(() => {
  vi.stubGlobal("URL", WebViewLikeURL);
  clientMock.getBaseUrl.mockReturnValue("eliza-local-agent://ipc");
  clientMock.getComputerUseApprovals.mockClear();
  openEventSourceMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("ComputerUseApprovalOverlay on native IPC base (Android WebView URL parser)", () => {
  it("renders without crashing and degrades to polling instead of opening SSE", async () => {
    expect(() => render(<ComputerUseApprovalOverlay />)).not.toThrow();

    await waitFor(() => {
      expect(clientMock.getComputerUseApprovals).toHaveBeenCalled();
    });
    expect(openEventSourceMock).not.toHaveBeenCalled();
  });

  it("still opens the SSE stream on a plain http base", async () => {
    clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
    render(<ComputerUseApprovalOverlay />);

    await waitFor(() => {
      expect(openEventSourceMock).toHaveBeenCalledWith(
        "http://127.0.0.1:31337/api/computer-use/approvals/stream",
      );
    });
  });
});
