// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeCloudSessionPort, NativeCloudSessionSnapshot } from "../../app/native-cloud-session";
import { unregisterPushToken } from "../notifications/push-registration";
import { useCloudState } from "../useCloudState";

const signOutOrder: string[] = [];
vi.mock("../notifications/push-registration", async (actual) => ({
  ...(await actual<typeof import("../notifications/push-registration")>()),
  unregisterPushToken: vi.fn(async () => { signOutOrder.push("unregister-push"); }),
}));
const snapshot = (userId: string): NativeCloudSessionSnapshot => ({status: { connected: true, enabled: true, hasApiKey: true, userId }, credits: { connected: true, balance: 12 }});
function port(): NativeCloudSessionPort {
  return {environment: "production", copy: { serviceName: "Cloud service", productName: "Test phone" }, read: vi.fn(async () => snapshot("current-owner")), activate: vi.fn(async () => {}), signOut: vi.fn(async () => {}), signIn: { startGoogle: vi.fn(), startEmail: vi.fn(), verifyEmail: vi.fn(), verifyMfa: vi.fn(), cancel: vi.fn(async () => {}) }};
}
const params = { setActionNotice: vi.fn(), loadWalletConfig: vi.fn(async () => {}), t: (key: string) => key };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("native Cloud sign-out and this device's push token", () => {
  it("drops this device's push token before the native sign-out revokes the credential", async () => {
    const native = port();
    vi.mocked(native.signOut).mockImplementation(async () => { signOutOrder.push("native-sign-out"); });
    const { result } = renderHook(() => useCloudState({ ...params, nativeCloudSession: native }));
    await waitFor(() => expect(result.current.elizaCloudConnected).toBe(true));
    signOutOrder.length = 0;
    await act(async () => { await result.current.handleCloudSignOut(); });
    // After the revoke the unregister request would be refused, and the
    // signed-out account's reminders would keep reaching this phone.
    expect(signOutOrder).toEqual(["unregister-push", "native-sign-out"]);
    expect(vi.mocked(unregisterPushToken)).toHaveBeenCalledTimes(1);
  });
});
