// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({
  requestPermissions: vi.fn(),
  startPreview: vi.fn(),
  stopPreview: vi.fn(),
  switchCamera: vi.fn(),
  capturePhoto: vi.fn(),
}));

vi.mock("@elizaos/capacitor-camera", () => ({
  Camera: camera,
}));

import { CameraPageView } from "./CameraPageView";

function grantAndStream() {
  camera.requestPermissions.mockResolvedValue({
    camera: "granted",
    microphone: "granted",
    photos: "granted",
  });
  camera.startPreview.mockResolvedValue({
    width: 1280,
    height: 720,
    deviceId: "back-0",
  });
  camera.stopPreview.mockResolvedValue(undefined);
  camera.switchCamera.mockResolvedValue({
    width: 1280,
    height: 720,
    deviceId: "front-0",
  });
  camera.capturePhoto.mockResolvedValue({
    base64: "QUJD",
    format: "jpeg",
    width: 1280,
    height: 720,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CameraPageView", () => {
  beforeEach(() => grantAndStream());

  it("requests permission and starts the live preview on mount", async () => {
    render(<CameraPageView />);
    await waitFor(() => expect(camera.requestPermissions).toHaveBeenCalled());
    await waitFor(() => expect(camera.startPreview).toHaveBeenCalledTimes(1));
    // Preview started in the back direction with a real preview element.
    const opts = camera.startPreview.mock.calls[0][0];
    expect(opts.direction).toBe("back");
    expect(opts.element).toBeInstanceOf(HTMLElement);
    // Live controls appear.
    expect(await screen.findByTestId("camera-capture")).toBeTruthy();
    expect(screen.getByTestId("camera-switch")).toBeTruthy();
  });

  it("captures a photo and shows the review overlay, then retakes", async () => {
    render(<CameraPageView />);
    const shutter = await screen.findByTestId("camera-capture");
    fireEvent.click(shutter);

    await waitFor(() =>
      expect(camera.capturePhoto).toHaveBeenCalledWith({
        format: "jpeg",
        quality: 90,
      }),
    );
    const review = await screen.findByTestId("camera-photo");
    const img = review.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,QUJD");

    // Retake returns to the live preview controls.
    fireEvent.click(screen.getByTestId("camera-retake"));
    await waitFor(() =>
      expect(screen.queryByTestId("camera-photo")).toBeNull(),
    );
    expect(screen.getByTestId("camera-capture")).toBeTruthy();
  });

  it("switches between front and back cameras", async () => {
    render(<CameraPageView />);
    const switchBtn = await screen.findByTestId("camera-switch");
    fireEvent.click(switchBtn);
    await waitFor(() =>
      expect(camera.switchCamera).toHaveBeenCalledWith({ direction: "front" }),
    );
  });

  it("stops the preview on unmount to release the camera", async () => {
    const { unmount } = render(<CameraPageView />);
    await screen.findByTestId("camera-capture");
    unmount();
    expect(camera.stopPreview).toHaveBeenCalled();
  });

  it("shows the permission-denied state and never starts a preview", async () => {
    camera.requestPermissions.mockResolvedValue({
      camera: "denied",
      microphone: "denied",
      photos: "denied",
    });
    render(<CameraPageView />);
    expect(await screen.findByTestId("camera-denied")).toBeTruthy();
    expect(camera.startPreview).not.toHaveBeenCalled();
    expect(screen.queryByTestId("camera-capture")).toBeNull();
  });

  it("surfaces an unavailable camera as the error state with a retry", async () => {
    camera.startPreview.mockRejectedValue(new Error("No camera found"));
    render(<CameraPageView />);
    const errorState = await screen.findByTestId("camera-error-state");
    expect(errorState.textContent).toContain("No camera found");
    expect(screen.getByTestId("camera-retry")).toBeTruthy();
  });
});
