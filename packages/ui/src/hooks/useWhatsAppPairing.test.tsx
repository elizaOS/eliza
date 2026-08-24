/** Verifies useWhatsAppPairing write failures surface to the user through the package's configured test harness. */
// @vitest-environment jsdom
//
// Behaviour test for the WhatsApp pairing hook's write paths. Drives the real
// hook against a client whose disconnect/stop verbs actually reject, and
// asserts the failure reaches the user-visible `error` state instead of being
// swallowed into a false "idle" (issue #12267).

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWhatsAppStatus = vi.fn();
const stopWhatsAppPairing = vi.fn();
const startWhatsAppPairing = vi.fn();
const disconnectWhatsApp = vi.fn();
const onWsEvent = vi.fn<(...args: unknown[]) => () => void>(() => () => {});

vi.mock("../api/client", () => ({
  client: {
    getWhatsAppStatus: (...args: unknown[]) => getWhatsAppStatus(...args),
    stopWhatsAppPairing: (...args: unknown[]) => stopWhatsAppPairing(...args),
    startWhatsAppPairing: (...args: unknown[]) => startWhatsAppPairing(...args),
    disconnectWhatsApp: (...args: unknown[]) => disconnectWhatsApp(...args),
    onWsEvent: (...args: unknown[]) => onWsEvent(...args),
  },
}));

import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "./useConnectorAccounts";
import { useWhatsAppPairing } from "./useWhatsAppPairing";

type HookResult = ReturnType<typeof useWhatsAppPairing>;

function HookProbe(props: { onState: (r: HookResult) => void }): null {
  const result = useWhatsAppPairing("acct-1");
  props.onState(result);
  return null;
}

function DefaultAccountProbe(props: {
  onState: (r: HookResult) => void;
}): null {
  const result = useWhatsAppPairing();
  props.onState(result);
  return null;
}

function wsHandler(event: string): (data: Record<string, unknown>) => void {
  const matches = onWsEvent.mock.calls.filter(([name]) => name === event);
  const call = matches[matches.length - 1];
  if (!call) {
    throw new Error(`no ${event} subscription was bound`);
  }
  return call[1] as (data: Record<string, unknown>) => void;
}

beforeEach(() => {
  getWhatsAppStatus.mockReset();
  stopWhatsAppPairing.mockReset();
  disconnectWhatsApp.mockReset();
  startWhatsAppPairing.mockReset();
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

describe("useWhatsAppPairing initial probe and socket stream", () => {
  it("reports connected when the initial probe finds existing auth", async () => {
    getWhatsAppStatus.mockResolvedValueOnce({ authExists: true });

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {});

    const last = seen[seen.length - 1];
    expect(getWhatsAppStatus).toHaveBeenCalledWith("acct-1");
    expect(last?.status).toBe("connected");
    expect(last?.error).toBeNull();
  });

  it("keeps the designed idle default when the initial probe fails", async () => {
    getWhatsAppStatus.mockRejectedValueOnce(new Error("probe down"));

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {});

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("idle");
    expect(last?.qrDataUrl).toBeNull();
    expect(last?.error).toBeNull();
  });

  it("stores qr payloads for its account and moves to waiting_for_qr", async () => {
    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    const emitQr = wsHandler("whatsapp-qr");
    await act(async () => {
      emitQr({ accountId: "acct-1", qrDataUrl: "data:image/png;base64,QQ==" });
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("waiting_for_qr");
    expect(last?.qrDataUrl).toBe("data:image/png;base64,QQ==");
  });

  it("ignores qr payloads for other accounts", async () => {
    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    const emitQr = wsHandler("whatsapp-qr");
    await act(async () => {
      emitQr({ accountId: "other", qrDataUrl: "data:image/png;base64,QQ==" });
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("idle");
    expect(last?.qrDataUrl).toBeNull();
  });

  it("ignores qr payloads whose data url is not a string", async () => {
    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    const emitQr = wsHandler("whatsapp-qr");
    await act(async () => {
      emitQr({ accountId: "acct-1", qrDataUrl: 42 });
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("idle");
    expect(last?.qrDataUrl).toBeNull();
  });

  it("applies valid status events, keeps the phone sticky, and clears the qr once connected", async () => {
    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    const emitStatus = wsHandler("whatsapp-status");
    const emitQr = wsHandler("whatsapp-qr");

    await act(async () => {
      emitStatus({
        accountId: "acct-1",
        status: "disconnected",
        phoneNumber: "+15550001111",
      });
    });
    await act(async () => {
      emitQr({ accountId: "acct-1", qrDataUrl: "data:image/png;base64,QQ==" });
    });
    await act(async () => {
      emitStatus({ accountId: "acct-1", status: "connected" });
    });

    const afterFirst = seen.find((r) => r.status === "disconnected");
    expect(afterFirst?.phoneNumber).toBe("+15550001111");

    const afterQr = seen.find((r) => r.status === "waiting_for_qr");
    expect(afterQr?.phoneNumber).toBe("+15550001111");
    expect(afterQr?.qrDataUrl).toBe("data:image/png;base64,QQ==");

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("connected");
    expect(last?.phoneNumber).toBe("+15550001111");
    expect(last?.qrDataUrl).toBeNull();
    expect(last?.error).toBeNull();
  });

  it("ignores status events carrying an unknown status value", async () => {
    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    const emitStatus = wsHandler("whatsapp-status");
    await act(async () => {
      emitStatus({ accountId: "acct-1", status: "carrier-pigeon" });
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("idle");
  });

  it("ignores status events for other accounts", async () => {
    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    const emitStatus = wsHandler("whatsapp-status");
    await act(async () => {
      emitStatus({ accountId: "other", status: "connected" });
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("idle");
  });
});

describe("useWhatsAppPairing lifecycle verbs beyond write failures", () => {
  it("startPairing surfaces the server refusal message as an error state", async () => {
    startWhatsAppPairing.mockResolvedValueOnce({
      ok: false,
      error: "pairing busy",
    });

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.startPairing();
    });

    expect(startWhatsAppPairing).toHaveBeenCalledWith("acct-1");
    const last = seen[seen.length - 1];
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("pairing busy");
  });

  it("startPairing refusal without an error field falls back to the default message", async () => {
    startWhatsAppPairing.mockResolvedValueOnce({ ok: false });

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.startPairing();
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("Failed to start pairing");
  });

  it("startPairing success holds initializing until the socket stream reports", async () => {
    startWhatsAppPairing.mockResolvedValueOnce({ ok: true });

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.startPairing();
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("initializing");
    expect(last?.qrDataUrl).toBeNull();
    expect(last?.phoneNumber).toBeNull();
    expect(last?.error).toBeNull();
  });

  it("startPairing thrown Error reaches the user as its message", async () => {
    startWhatsAppPairing.mockRejectedValueOnce(new Error("boom"));

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.startPairing();
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("boom");
  });

  it("startPairing non-Error throw values are stringified", async () => {
    startWhatsAppPairing.mockRejectedValueOnce("nope");

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.startPairing();
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("nope");
  });

  it("successful stop resets every pairing field", async () => {
    stopWhatsAppPairing.mockResolvedValueOnce({ ok: true });

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    const emitQr = wsHandler("whatsapp-qr");
    await act(async () => {
      emitQr({ accountId: "acct-1", qrDataUrl: "data:image/png;base64,QQ==" });
    });
    expect(seen[seen.length - 1]?.status).toBe("waiting_for_qr");

    await act(async () => {
      await seen[seen.length - 1]?.stopPairing();
    });

    expect(stopWhatsAppPairing).toHaveBeenCalledWith("acct-1");
    const last = seen[seen.length - 1];
    expect(last?.status).toBe("idle");
    expect(last?.qrDataUrl).toBeNull();
    expect(last?.phoneNumber).toBeNull();
    expect(last?.error).toBeNull();
  });

  it("stop failure with a non-Error rejection uses the fallback text", async () => {
    stopWhatsAppPairing.mockRejectedValueOnce("nope");

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.stopPairing();
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("Failed to stop pairing");
  });

  it("disconnect failure with a non-Error rejection uses the fallback text", async () => {
    disconnectWhatsApp.mockRejectedValueOnce("nope");

    const seen: HookResult[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    await act(async () => {
      await seen[seen.length - 1]?.disconnect();
    });

    const last = seen[seen.length - 1];
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("Failed to disconnect");
  });

  it("mounts against the shared connector account when called without arguments", () => {
    const seen: HookResult[] = [];
    render(<DefaultAccountProbe onState={(r) => seen.push(r)} />);

    expect(getWhatsAppStatus).toHaveBeenCalledWith(
      DEFAULT_CONNECTOR_ACCOUNT_ID,
    );
    expect(seen[seen.length - 1]?.status).toBe("idle");
  });
});
