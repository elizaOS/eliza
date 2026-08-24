/**
 * Unit coverage for the desktop dialog helpers: `confirmDesktopAction` /
 * `alertDesktopMessage` must parse every shape the Electrobun RPC layer is
 * known to return for `desktopShowMessageBox` — including a bare falsy `0`
 * button index that a truthiness check would silently misread as "no bridge" —
 * unwrap `{data|result|payload}` envelopes, and fall back to `window.confirm`
 * / `window.alert` with title/message/detail joined text only when no native
 * answer exists. Real module logic throughout; the Electrobun RPC and runtime
 * detection are mocked at their module boundary (no desktop shell under
 * vitest), jsdom supplies `window`.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { alertDesktopMessage, confirmDesktopAction } from "./desktop-dialogs";

vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: vi.fn(async () => null),
}));

vi.mock("../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: vi.fn(() => false),
}));

const bridgeRequest = vi.mocked(invokeDesktopBridgeRequest);
const isElectro = vi.mocked(isElectrobunRuntime);

const confirmSpy = () => vi.spyOn(window, "confirm").mockReturnValue(true);
const alertSpy = () => vi.spyOn(window, "alert").mockImplementation(() => {});

describe("confirmDesktopAction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bridgeRequest.mockClear();
    bridgeRequest.mockImplementation(async () => null);
    isElectro.mockReturnValue(false);
  });

  it("treats a native {response: 0} as Confirm and sends default params", async () => {
    bridgeRequest.mockResolvedValueOnce({ response: 0 });
    const confirm = confirmSpy();

    await expect(
      confirmDesktopAction({ title: "Sign out", message: "Really leave?" }),
    ).resolves.toBe(true);

    expect(confirm).not.toHaveBeenCalled();
    expect(bridgeRequest).toHaveBeenCalledOnce();
    expect(bridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopShowMessageBox",
        ipcChannel: "desktop:showMessageBox",
        params: expect.objectContaining({
          type: "question",
          title: "Sign out",
          message: "Really leave?",
          buttons: ["Confirm", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        }),
      }),
    );
  });

  it("treats a bare falsy 0 payload as Confirm — never trust truthiness here", async () => {
    // Electrobun may return the button index without an envelope; 0 is falsy,
    // so the parser must consult it explicitly rather than `if (payload)`.
    bridgeRequest.mockResolvedValueOnce(0);

    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(true);
    expect(confirmSpy()).not.toHaveBeenCalled();
  });

  it("maps index 1 (and any non-zero index) to Cancel", async () => {
    bridgeRequest.mockResolvedValueOnce({ response: 1 });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(false);

    bridgeRequest.mockResolvedValueOnce({ response: 2 });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(false);
  });

  it("unwraps one-level {data} / {result} / {payload} envelopes", async () => {
    bridgeRequest.mockResolvedValueOnce({ data: { response: 0 } });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(true);

    bridgeRequest.mockResolvedValueOnce({ result: 1 });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(false);

    bridgeRequest.mockResolvedValueOnce({ payload: { response: 0 } });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(true);
  });

  it("prefers a usable envelope entry over an outer response field", async () => {
    // data: null is unusable, so the parser falls through to `response`;
    // had data been usable, the outer field would be ignored.
    bridgeRequest.mockResolvedValueOnce({ data: null, response: 0 });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(true);
  });

  it("coerces string and BigInt button indices from the RPC layer", async () => {
    bridgeRequest.mockResolvedValueOnce({ response: "0" });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(true);

    bridgeRequest.mockResolvedValueOnce({ response: BigInt(1) });
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(false);

    bridgeRequest.mockResolvedValueOnce("1");
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(false);
  });

  it("falls back to window.confirm with joined text when the native answer is unparseable", async () => {
    bridgeRequest.mockResolvedValueOnce({ response: "not-a-number" });
    const confirm = confirmSpy().mockReturnValue(true);

    await expect(
      confirmDesktopAction({
        title: "Delete wallet",
        message: "Cannot be undone",
        detail: "Keys stay on device",
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      "Delete wallet\n\nCannot be undone\n\nKeys stay on device",
    );

    bridgeRequest.mockResolvedValueOnce({});
    const confirmNo = confirmSpy().mockReturnValue(false);
    await expect(
      confirmDesktopAction({ title: "t", message: "m" }),
    ).resolves.toBe(false);
    expect(confirmNo).toHaveBeenCalledWith("t\n\nm");
  });

  it("falls back to window.confirm when no native bridge answered", async () => {
    const confirm = confirmSpy().mockReturnValue(false);

    await expect(
      confirmDesktopAction({
        title: "Enable sync",
        message: "Upload keys?",
        detail: "End-to-end encrypted",
        type: "warning",
      }),
    ).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      "Enable sync\n\nUpload keys?\n\nEnd-to-end encrypted",
    );
    expect(bridgeRequest).toHaveBeenCalledOnce();
  });

  it("passes custom labels and dialog type through to the native sheet", async () => {
    bridgeRequest.mockResolvedValueOnce(null);
    confirmSpy();

    await confirmDesktopAction({
      title: "t",
      message: "m",
      type: "warning",
      confirmLabel: "Yes, reset",
      cancelLabel: "Keep",
    });

    expect(bridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          type: "warning",
          buttons: ["Yes, reset", "Keep"],
        }),
      }),
    );
  });
});

describe("alertDesktopMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bridgeRequest.mockClear();
    bridgeRequest.mockImplementation(async () => null);
  });

  it("does not touch window.alert when the native sheet handled it", async () => {
    bridgeRequest.mockResolvedValueOnce(0);
    const alert = alertSpy();

    await expect(
      alertDesktopMessage({ title: "Saved", message: "All done" }),
    ).resolves.toBeUndefined();
    expect(alert).not.toHaveBeenCalled();
    expect(bridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          type: "info",
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
        }),
      }),
    );
  });

  it("falls back to window.alert with the joined text when no bridge answered", async () => {
    const alert = alertSpy();

    await expect(
      alertDesktopMessage({
        title: "Update failed",
        message: "Check your connection",
        detail: "Retry later",
      }),
    ).resolves.toBeUndefined();

    expect(alert).toHaveBeenCalledExactlyOnceWith(
      "Update failed\n\nCheck your connection\n\nRetry later",
    );
  });

  it("treats undefined exactly like null: no native sheet ran", async () => {
    const alert = alertSpy();
    bridgeRequest.mockResolvedValueOnce(undefined);

    await alertDesktopMessage({ title: "t", message: "m" });
    expect(alert).toHaveBeenCalledExactlyOnceWith("t\n\nm");
  });
});
