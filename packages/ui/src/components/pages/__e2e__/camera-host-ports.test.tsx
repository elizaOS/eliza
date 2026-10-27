// @vitest-environment jsdom

import {
  act,
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
  capturePhoto: vi.fn(),
  switchCamera: vi.fn(),
}));

vi.mock("@elizaos/capacitor-camera", async (importActual) => ({
  ...(await importActual<typeof import("@elizaos/capacitor-camera")>()),
  Camera: camera,
}));

import { CameraPageView } from "../CameraPageView";

const photo = { base64: "AA==", format: "jpeg", width: 4, height: 3 };

describe("CameraPageView host ports", () => {
  beforeEach(() => {
    camera.requestPermissions.mockResolvedValue({ camera: "granted" });
    camera.startPreview.mockResolvedValue({ width: 4, height: 3 });
    camera.stopPreview.mockResolvedValue(undefined);
    camera.capturePhoto.mockResolvedValue(photo);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("only previews a capture when the host supplies no ports", async () => {
    render(<CameraPageView />);
    fireEvent.click(await screen.findByTestId("camera-capture"));
    expect(await screen.findByTestId("camera-photo")).toBeTruthy();
    expect(screen.queryByTestId("camera-keep")).toBeNull();
  });

  it("keeps a capture only on an explicit Keep, with one identity per capture", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge closed"))
      .mockResolvedValueOnce({ status: "saved", id: "42" });
    const scan = vi.fn();
    render(
      <CameraPageView
        ports={{
          keep: { label: "Keep photo", run },
          actions: [{ id: "scan", label: "Scan", run: scan }],
        }}
      />,
    );
    fireEvent.click(await screen.findByTestId("camera-capture"));
    await screen.findByTestId("camera-photo");
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("camera-keep"));
    expect((await screen.findByTestId("camera-keep-status")).textContent).toMatch(
      /could not be confirmed/,
    );
    fireEvent.click(screen.getByTestId("camera-keep"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-keep-status").textContent).toBe(
        "Photo kept.",
      ),
    );
    expect(run).toHaveBeenCalledTimes(2);
    const [first, second] = run.mock.calls;
    expect(first[1]).toBe(second[1]);
    expect((screen.getByTestId("camera-keep") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("camera-action-scan"));
    await waitFor(() => expect(scan).toHaveBeenCalledWith(photo));
    // A new capture gets a new identity.
    fireEvent.click(screen.getByTestId("camera-retake"));
    run.mockResolvedValueOnce({ status: "saved" });
    fireEvent.click(await screen.findByTestId("camera-capture"));
    fireEvent.click(await screen.findByTestId("camera-keep"));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(run.mock.calls[2][1]).not.toBe(first[1]);
  });

  it("restarts a denied preview on return only after a grant in settings", async () => {
    camera.requestPermissions.mockResolvedValue({ camera: "denied" });
    const checkAccess = vi.fn().mockResolvedValue({ camera: "denied" });
    render(<CameraPageView ports={{ checkAccess }} />);
    await screen.findByTestId("camera-denied");
    const resume = async () => {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    await resume();
    await waitFor(() => expect(checkAccess).toHaveBeenCalledTimes(1));
    expect(camera.requestPermissions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("camera-denied")).toBeTruthy();
    checkAccess.mockResolvedValue({ camera: "granted" });
    camera.requestPermissions.mockResolvedValue({ camera: "granted" });
    await resume();
    expect(await screen.findByTestId("camera-capture")).toBeTruthy();
    expect(camera.startPreview).toHaveBeenCalledTimes(1);
  });

  it("treats only an explicit denial as a permission state", async () => {
    camera.startPreview.mockRejectedValueOnce(new Error("Camera is in use"));
    render(<CameraPageView />);
    expect(await screen.findByTestId("camera-error-state")).toBeTruthy();
    cleanup();
    camera.startPreview.mockRejectedValueOnce(
      Object.assign(new Error("Camera permission denied"), {
        code: "CAMERA_PERMISSION_DENIED",
      }),
    );
    render(<CameraPageView />);
    expect(await screen.findByTestId("camera-denied")).toBeTruthy();
  });
});
