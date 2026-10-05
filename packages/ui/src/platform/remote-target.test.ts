/** Native lifecycle routing never follows the selected remote agent or retries mutations. */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  platform: "android",
  request: vi.fn(),
  desktop: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => boundary.platform },
  registerPlugin: () => ({ request: boundary.request }),
}));
vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: boundary.desktop,
}));
vi.mock("../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => boundary.platform === "linux",
}));

import {
  confirmRemoteTargetPairing,
  enrollRemoteTarget,
  finalizeRemoteTargetHostRevoke,
  getLocalBrowserProfile,
  getRemoteTargetIdentity,
  getRemoteTargetStatus,
  startRemoteTarget,
} from "./remote-target";

function reply(value: unknown) {
  boundary.request.mockResolvedValueOnce({
    status: 200,
    body: JSON.stringify(value),
  });
}
afterEach(() => {
  vi.resetAllMocks();
  boundary.platform = "android";
  localStorage.clear();
});
it("enrolls the Android device through local native IPC while a cloud agent is selected", async () => {
  localStorage.setItem(
    "eliza:api-base",
    "https://selected-cloud.example.invalid",
  );
  reply({
    hostId: "phone",
    status: "active",
    identity: { runtimeId: "phone" },
  });
  await enrollRemoteTarget({
    apiBaseUrl: "https://cloud.example.invalid",
    ownerId: "owner",
    ownerAccessToken: "fixture-token",
    displayName: "Phone",
    platform: "android",
  });
  expect(boundary.request).toHaveBeenCalledOnce();
  const request = boundary.request.mock.calls[0][0];
  expect(request.path).toBe("/api/remote-target/enroll");
  expect(request.method).toBe("POST");
  expect(JSON.parse(request.body).platform).toBe("android");
  expect(request.headers).toEqual({ "Content-Type": "application/json" });
  expect(boundary.desktop).not.toHaveBeenCalled();
});
it("only includes browser permission on explicit confirmation", async () => {
  reply({ status: "active", sessionId: "one" });
  await confirmRemoteTargetPairing("one");
  expect(JSON.parse(boundary.request.mock.calls[0][0].body)).toEqual({
    sessionId: "one",
  });
  reply({ status: "active", sessionId: "two" });
  await confirmRemoteTargetPairing("two", "exact-profile");
  expect(JSON.parse(boundary.request.mock.calls[1][0].body)).toEqual({
    sessionId: "two",
    browserProfileId: "exact-profile",
  });
});
it("reads device status and browser identity locally and preserves native desktop routing", async () => {
  reply({ enrolled: false });
  await getRemoteTargetIdentity();
  reply({ running: false });
  await getRemoteTargetStatus();
  reply({ connected: { profileId: "phone-profile" } });
  expect(await getLocalBrowserProfile()).toBe("phone-profile");
  expect(
    boundary.request.mock.calls.map(([request]) => [
      request.path,
      request.method,
    ]),
  ).toEqual([
    ["/api/remote-target/identity", "GET"],
    ["/api/remote-target/status", "GET"],
    ["/api/browser-device/profile", "GET"],
  ]);
  boundary.platform = "linux";
  boundary.desktop.mockResolvedValueOnce({ status: "active" });
  await confirmRemoteTargetPairing("desktop", "desktop-profile");
  expect(boundary.desktop).toHaveBeenCalledWith({
    rpcMethod: "remoteTargetConfirmPairing",
    ipcChannel: "remoteTarget:confirmPairing",
    params: { sessionId: "desktop", browserProfileId: "desktop-profile" },
  });
});
it("does not retry or use a remote fallback after local failure", async () => {
  boundary.request.mockRejectedValueOnce(new Error("uncertain socket reply"));
  await expect(startRemoteTarget()).rejects.toThrow("uncertain socket reply");
  expect(boundary.request).toHaveBeenCalledOnce();
  expect(boundary.desktop).not.toHaveBeenCalled();
  boundary.request.mockResolvedValueOnce({
    status: 503,
    body: "private diagnostic",
  });
  await expect(finalizeRemoteTargetHostRevoke("host")).rejects.toThrow(
    "Local device request failed (503)",
  );
});
