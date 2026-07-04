// @vitest-environment jsdom
//
// Behaviour test for the WhatsApp pairing hook's write paths. Drives the real
// hook against a client whose disconnect/stop verbs actually reject, and
// asserts the failure reaches the user-visible `error` state instead of being
// swallowed into a false "idle" (issue #12267).

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWhatsAppStatus = vi.fn();
const stopWhatsAppPairing = vi.fn();
const disconnectWhatsApp = vi.fn();
const onWsEvent = vi.fn(() => () => {});

vi.mock("../api/client", () => ({
  client: {
    getWhatsAppStatus: (...args: unknown[]) => getWhatsAppStatus(...args),
    stopWhatsAppPairing: (...args: unknown[]) => stopWhatsAppPairing(...args),
    disconnectWhatsApp: (...args: unknown[]) => disconnectWhatsApp(...args),
    onWsEvent: (...args: unknown[]) => onWsEvent(...args),
  },
}));

import { useWhatsAppPairing } from "./useWhatsAppPairing";

type HookResult = ReturnType<typeof useWhatsAppPairing>;

function HookProbe(props: { onState: (r: HookResult) => void }): null {
  const result = useWhatsAppPairing("acct-1");
  props.onState(result);
  return null;
}

beforeEach(() => {
  getWhatsAppStatus.mockReset();
  stopWhatsAppPairing.mockReset();
  disconnectWhatsApp.mockReset();
  onWsEvent.mockReset();
  onWsEvent.mockReturnValue(() => {});
  // Initial-status probe: keep it benign so the mount effect settles at "idle".
  getWhatsAppStatus.mockResolvedValue({ authExists: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useWhatsAppPairing write failures surface to the user", () => {
  it("disconnect failure sets error state, not a false idle", async () => {
    disconnectWhatsApp.mockRejectedValueOnce(new Error("network down"));

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.disconnect();
    });

    const last = seen[seen.length - 1];
    expect(disconnectWhatsApp).toHaveBeenCalledWith("acct-1");
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("network down");
  });

  it("stop failure sets error state, not a false idle", async () => {
    stopWhatsAppPairing.mockRejectedValueOnce(new Error("stop failed"));

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.stopPairing();
    });

    const last = seen[seen.length - 1];
    expect(stopWhatsAppPairing).toHaveBeenCalledWith("acct-1");
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("stop failed");
  });

  it("successful disconnect resets to idle with no error", async () => {
    disconnectWhatsApp.mockResolvedValueOnce({ ok: true });

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.disconnect();
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("idle");
    expect(last?.error).toBeNull();
  });
});
