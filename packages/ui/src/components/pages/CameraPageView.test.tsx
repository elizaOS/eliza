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

/** A promise whose resolver we hold, to model an in-flight bridge call. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("CameraPageView — controls, idempotency & recovery", () => {
  beforeEach(() => grantAndStream());

  it("pins the switch/shutter tap-target sizing class tokens (h-11 / h-[72px]) — guards token drift, not rendered px (jsdom has no layout)", async () => {
    render(<CameraPageView />);
    // Tailwind h-11/w-11 == 2.75rem == 44px — the platform minimum touch target.
    const switchBtn = await screen.findByTestId("camera-switch");
    expect(switchBtn.className).toContain("h-11");
    expect(switchBtn.className).toContain("w-11");
    const shutter = screen.getByTestId("camera-capture");
    expect(shutter.className).toContain("h-[72px]");
    expect(shutter.className).toContain("w-[72px]");
  });

  it("fires exactly one capture for a rapid double-tap on the shutter", async () => {
    const pending = deferred<{
      base64: string;
      format: string;
      width: number;
      height: number;
    }>();
    camera.capturePhoto.mockReturnValue(pending.promise);

    render(<CameraPageView />);
    const shutter = await screen.findByTestId("camera-capture");
    fireEvent.click(shutter);
    fireEvent.click(shutter); // second tap while the first is in flight

    expect(camera.capturePhoto).toHaveBeenCalledTimes(1);
    // The busy guard also disables the shutter mid-capture.
    expect(shutter.hasAttribute("disabled")).toBe(true);

    pending.resolve({ base64: "QUJD", format: "jpeg", width: 1, height: 1 });
    await screen.findByTestId("camera-photo");
    expect(camera.capturePhoto).toHaveBeenCalledTimes(1);
  });

  it("fires exactly one switch for a rapid double-tap while switching", async () => {
    const pending = deferred<{
      width: number;
      height: number;
      deviceId: string;
    }>();
    camera.switchCamera.mockReturnValue(pending.promise);

    render(<CameraPageView />);
    const switchBtn = await screen.findByTestId("camera-switch");
    fireEvent.click(switchBtn);
    fireEvent.click(switchBtn);

    expect(camera.switchCamera).toHaveBeenCalledTimes(1);
    expect(switchBtn.hasAttribute("disabled")).toBe(true);

    pending.resolve({ width: 1, height: 1, deviceId: "front" });
    await waitFor(() => expect(switchBtn.hasAttribute("disabled")).toBe(false));
    expect(camera.switchCamera).toHaveBeenCalledTimes(1);
  });

  it("toggles facing back to the rear camera on a second switch", async () => {
    render(<CameraPageView />);
    const switchBtn = await screen.findByTestId("camera-switch");
    fireEvent.click(switchBtn);
    await waitFor(() =>
      expect(camera.switchCamera).toHaveBeenLastCalledWith({
        direction: "front",
      }),
    );
    // Wait for the busy/facing state to settle before the next tap.
    await waitFor(() => expect(switchBtn.hasAttribute("disabled")).toBe(false));
    fireEvent.click(switchBtn);
    await waitFor(() =>
      expect(camera.switchCamera).toHaveBeenLastCalledWith({
        direction: "back",
      }),
    );
  });

  it("surfaces a switch failure as a non-fatal live toast and stays capturable", async () => {
    camera.switchCamera.mockRejectedValue(new Error("switch failed"));
    render(<CameraPageView />);
    fireEvent.click(await screen.findByTestId("camera-switch"));

    const toast = await screen.findByTestId("camera-error");
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.textContent).toContain("switch failed");
    // Preview is still live; the shutter remains available and re-enabled.
    const shutter = screen.getByTestId("camera-capture");
    expect(shutter).toBeTruthy();
    await waitFor(() => expect(shutter.hasAttribute("disabled")).toBe(false));
    // A failed switch must not flip the tracked facing.
    expect(screen.queryByTestId("camera-photo")).toBeNull();
  });

  it("surfaces a capture failure as a live toast without a photo overlay", async () => {
    camera.capturePhoto.mockRejectedValue(new Error("capture boom"));
    render(<CameraPageView />);
    fireEvent.click(await screen.findByTestId("camera-capture"));

    const toast = await screen.findByTestId("camera-error");
    expect(toast.textContent).toContain("capture boom");
    expect(screen.queryByTestId("camera-photo")).toBeNull();
    // Shutter re-enables so the user can retry the shot.
    await waitFor(() =>
      expect(
        screen.getByTestId("camera-capture").hasAttribute("disabled"),
      ).toBe(false),
    );
  });

  it("recovers from denied to a live preview when access is granted on retry", async () => {
    camera.requestPermissions.mockResolvedValueOnce({
      camera: "denied",
      microphone: "denied",
      photos: "denied",
    });
    render(<CameraPageView />);
    await screen.findByTestId("camera-denied");
    expect(camera.startPreview).not.toHaveBeenCalled();

    // The recovery callout's retry re-requests permission (now granted).
    fireEvent.click(screen.getByTestId("camera-permission-callout-retry"));
    expect(await screen.findByTestId("camera-capture")).toBeTruthy();
    expect(camera.startPreview).toHaveBeenCalledTimes(1);
    expect(camera.startPreview.mock.calls[0][0].direction).toBe("back");
  });

  it("recovers from the error state to a live preview via retry", async () => {
    camera.startPreview.mockRejectedValueOnce(new Error("No camera found"));
    render(<CameraPageView />);
    await screen.findByTestId("camera-error-state");

    fireEvent.click(screen.getByTestId("camera-retry"));
    expect(await screen.findByTestId("camera-capture")).toBeTruthy();
    expect(camera.startPreview).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("camera-error-state")).toBeNull();
  });

  it("passes through a capture result that is already a data URL", async () => {
    camera.capturePhoto.mockResolvedValue({
      base64: "data:image/png;base64,ZZZ",
      format: "png",
      width: 1,
      height: 1,
    });
    render(<CameraPageView />);
    fireEvent.click(await screen.findByTestId("camera-capture"));
    const review = await screen.findByTestId("camera-photo");
    expect(review.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,ZZZ",
    );
  });
});
