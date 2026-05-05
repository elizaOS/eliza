// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getWhatsAppStatus: vi.fn(),
    startWhatsAppPairing: vi.fn(),
    stopWhatsAppPairing: vi.fn(),
    disconnectWhatsApp: vi.fn(),
    onWsEvent: vi.fn(() => vi.fn()),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));

import { useWhatsAppPairing } from "./useWhatsAppPairing";

describe("useWhatsAppPairing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getWhatsAppStatus.mockResolvedValue({
      accountId: "default",
      authScope: "lifeops",
      status: "idle",
      authExists: false,
      serviceConnected: false,
      servicePhone: null,
    });
  });

  it("keeps stale local auth recoverable instead of marking it connected", async () => {
    clientMock.getWhatsAppStatus.mockResolvedValueOnce({
      accountId: "default",
      authScope: "lifeops",
      status: "idle",
      authExists: true,
      serviceConnected: false,
      servicePhone: null,
    });

    const { result, unmount } = renderHook(() => useWhatsAppPairing());

    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    expect(result.current.error).toBeNull();
    unmount();
  });

  it("marks the session connected only when the runtime service is connected", async () => {
    clientMock.getWhatsAppStatus.mockResolvedValueOnce({
      accountId: "default",
      authScope: "lifeops",
      status: "connected",
      authExists: true,
      serviceConnected: true,
      servicePhone: "14153024399",
    });

    const { result, unmount } = renderHook(() => useWhatsAppPairing());

    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.phoneNumber).toBe("14153024399");
    unmount();
  });
});
