// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeCloudSessionPort, NativeCloudSessionSnapshot } from "../../app/native-cloud-session";
import { client } from "../../api/client";
import { activateAndroidNativeCloudSignIn, getAndroidNativeCloudSignInRequest, resetAndroidNativeCloudSignInForTesting } from "../../android-cloud/native-cloud-sign-in";
import { useCloudState } from "../useCloudState";
const snapshot = (userId: string): NativeCloudSessionSnapshot => ({status: { connected: true, enabled: true, hasApiKey: true, userId }, credits: { connected: true, balance: 12 }});
function port(read: NativeCloudSessionPort["read"] = async () => snapshot("current-owner")): NativeCloudSessionPort {
  return {environment: "production", copy: { serviceName: "Cloud service", productName: "Test phone" }, read: vi.fn(read), activate: vi.fn(async () => {}), signOut: vi.fn(async () => {}), signIn: { startGoogle: vi.fn(), startEmail: vi.fn(), verifyEmail: vi.fn(), verifyMfa: vi.fn(), cancel: vi.fn(async () => {}) }};
}
const params = { setActionNotice: vi.fn(), loadWalletConfig: vi.fn(async () => {}), t: (key: string) => key };
afterEach(() => { cleanup(); resetAndroidNativeCloudSignInForTesting(); vi.restoreAllMocks(); });
describe("native account within the common Cloud state owner", () => {
  it("uses the host's verified snapshot without probing a second account backend", async () => {
    const legacy = vi.spyOn(client, "getCloudStatus");
    const native = port();
    const { result } = renderHook(() => useCloudState({ ...params, nativeCloudSession: native }));
    await waitFor(() => expect(result.current.elizaCloudUserId).toBe("current-owner"));
    expect(result.current.elizaCloudConnected).toBe(true);
    expect(result.current.elizaCloudCredits).toBe(12);
    expect(legacy).not.toHaveBeenCalled();
  });
  it("does not publish a late account read from a replaced native owner", async () => {
    let answer!: (value: NativeCloudSessionSnapshot) => void;
    const previous = port(() => new Promise(resolve => { answer = resolve; }));
    const next = port(async () => snapshot("replacement-owner"));
    const { result, rerender } = renderHook(({ native }) => useCloudState({ ...params, nativeCloudSession: native }), { initialProps: { native: previous } });
    await waitFor(() => expect(previous.read).toHaveBeenCalled());
    rerender({ native: next });
    await waitFor(() => expect(result.current.elizaCloudUserId).toBe("replacement-owner"));
    await act(async () => { answer(snapshot("retired-owner")); });
    expect(result.current.elizaCloudUserId).toBe("replacement-owner");
  });
  it("retains account state when native retirement refuses and clears it only after acknowledgement", async () => {
    const native = port();
    const { result } = renderHook(() => useCloudState({ ...params, nativeCloudSession: native }));
    await waitFor(() => expect(result.current.elizaCloudConnected).toBe(true));
    vi.mocked(native.signOut).mockRejectedValueOnce(new Error("old-token child stop unconfirmed"));
    await act(async () => { await expect(result.current.handleCloudSignOut()).rejects.toThrow("stop unconfirmed"); });
    expect(result.current.elizaCloudConnected).toBe(true);
    expect(result.current.elizaCloudDisconnecting).toBe(false);
    await act(async () => { await result.current.handleCloudSignOut(); });
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudUserId).toBeNull();
    expect(native.signOut).toHaveBeenCalledTimes(2);
  });
  it("routes sign-in activation through the supplied installed credential owner", async () => {
    let signedIn = false;
    const native = port(async () => signedIn ? snapshot("new-owner") : { status: { connected: false }, credits: null });
    vi.mocked(native.activate).mockImplementation(async () => { signedIn = true; });
    const { result } = renderHook(() => useCloudState({ ...params, nativeCloudSession: native }));
    await waitFor(() => expect(result.current.elizaCloudStatusLoading).toBe(false));
    let login!: Promise<void>;
    act(() => { login = result.current.handleCloudLogin(null, { requireClientAuth: true }); });
    const request = getAndroidNativeCloudSignInRequest()!;
    expect(request.port).toBe(native.signIn);
    expect(request.copy).toEqual(native.copy);
    const completion = { status: "authenticated", environment: "production", expiresAt: Date.now()+60_000, accountCreated: false };
    await act(async () => { await activateAndroidNativeCloudSignIn(request.id, completion, new AbortController().signal); await login; });
    expect(native.activate).toHaveBeenCalledWith(completion, expect.any(AbortSignal));
    expect(result.current.elizaCloudUserId).toBe("new-owner");
    expect(result.current.elizaCloudLoginBusy).toBe(false);
  });
});
