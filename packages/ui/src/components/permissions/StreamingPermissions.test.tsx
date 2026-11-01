// @vitest-environment jsdom
/**
 * Mobile streaming permission requests stay scoped to the row that was
 * granted. Camera uses the ElizaCamera plugin's scoped request, microphone
 * uses the TalkMode plugin, and the generic ElizaCamera request (camera +
 * microphone + storage together) never runs. This is the #38310 scoping
 * applied to the second surface that still used the generic request.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../../i18n/index";
import { seedAppValue } from "../../state/app-store";
import type { AppContextValue } from "../../state/types";
import { StreamingPermissionsSettingsView } from "./StreamingPermissions";

const talkModeMocks = vi.hoisted(() => ({
  requestPermissions: vi.fn(async () => ({ microphone: "granted" })),
}));

vi.mock("../../bridge/native-plugins", () => ({
  getTalkModePlugin: () => ({
    requestPermissions: talkModeMocks.requestPermissions,
  }),
}));

const cameraMocks = {
  checkPermissions: vi.fn(async () => ({
    camera: "prompt",
    microphone: "prompt",
  })),
  requestPermissions: vi.fn(async () => ({
    camera: "granted",
    microphone: "granted",
  })),
  requestCameraPermission: vi.fn(async () => ({ camera: "granted" })),
};

beforeEach(() => {
  seedAppValue({ t: createTranslator("en") } as AppContextValue);
  vi.clearAllMocks();
  (globalThis as Record<string, unknown>).Capacitor = {
    Plugins: { ElizaCamera: cameraMocks },
  };
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).Capacitor;
});

describe("StreamingPermissionsSettingsView (mobile)", () => {
  it("requests only camera for the camera row", async () => {
    render(
      <StreamingPermissionsSettingsView
        mode="mobile"
        testId="streaming-permissions"
        title="Streaming"
      />,
    );
    const grantCamera = await screen.findByRole("button", {
      name: "Grant Camera",
    });
    fireEvent.click(grantCamera);
    await waitFor(() => {
      expect(cameraMocks.requestCameraPermission).toHaveBeenCalledTimes(1);
    });
    expect(cameraMocks.requestPermissions).not.toHaveBeenCalled();
    expect(talkModeMocks.requestPermissions).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Grant Camera" }),
      ).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Grant Microphone" }),
    ).not.toBeNull();
  });

  it("requests microphone through TalkMode, not through the camera plugin", async () => {
    render(
      <StreamingPermissionsSettingsView
        mode="mobile"
        testId="streaming-permissions"
        title="Streaming"
      />,
    );
    const grantMicrophone = await screen.findByRole("button", {
      name: "Grant Microphone",
    });
    fireEvent.click(grantMicrophone);
    await waitFor(() => {
      expect(talkModeMocks.requestPermissions).toHaveBeenCalledTimes(1);
    });
    expect(cameraMocks.requestPermissions).not.toHaveBeenCalled();
    expect(cameraMocks.requestCameraPermission).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Grant Microphone" }),
      ).toBeNull();
    });
  });
});
