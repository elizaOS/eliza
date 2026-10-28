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
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}));

vi.mock("@elizaos/capacitor-camera", async (importActual) => ({
  ...(await importActual<typeof import("@elizaos/capacitor-camera")>()),
  Camera: camera,
}));

import { CameraPageView } from "../CameraPageView";

const photo = { base64: "AA==", format: "jpeg", width: 4, height: 3 };
const recording = {
  path: "/cache/rec.mp4",
  duration: 3.2,
  width: 4,
  height: 3,
  fileSize: 10,
  mimeType: "video/mp4",
};

describe("CameraPageView host ports", () => {
  beforeEach(() => {
    camera.requestPermissions.mockResolvedValue({ camera: "granted" });
    camera.startPreview.mockResolvedValue({ width: 4, height: 3 });
    camera.stopPreview.mockResolvedValue(undefined);
    camera.capturePhoto.mockResolvedValue(photo);
    camera.startRecording.mockResolvedValue(undefined);
    camera.stopRecording.mockResolvedValue(recording);
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

  it("retries a definite Keep failure under a fresh identity", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", message: "Not kept." })
      .mockResolvedValueOnce({ status: "saved" });
    render(<CameraPageView ports={{ keep: { label: "Keep photo", run } }} />);
    fireEvent.click(await screen.findByTestId("camera-capture"));
    fireEvent.click(await screen.findByTestId("camera-keep"));
    expect((await screen.findByTestId("camera-keep-status")).textContent).toBe(
      "Not kept.",
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("camera-keep") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("camera-keep"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-keep-status").textContent).toBe(
        "Photo kept.",
      ),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).not.toBe(run.mock.calls[0][1]);
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

  it("releases a preview that comes up after the view unmounted", async () => {
    let started!: () => void;
    camera.startPreview.mockReturnValueOnce(
      new Promise((resolve) => {
        started = () => resolve({ width: 4, height: 3 });
      }),
    );
    const view = render(<CameraPageView />);
    await waitFor(() => expect(camera.startPreview).toHaveBeenCalledTimes(1));
    view.unmount();
    await waitFor(() => expect(camera.stopPreview).toHaveBeenCalledTimes(1));
    started();
    await waitFor(() => expect(camera.stopPreview).toHaveBeenCalledTimes(2));
  });

  it("captures one photo at a time", async () => {
    let captured!: (value: typeof photo) => void;
    camera.capturePhoto.mockReturnValueOnce(
      new Promise((resolve) => {
        captured = resolve;
      }),
    );
    render(<CameraPageView />);
    const shutter = await screen.findByTestId("camera-capture");
    fireEvent.click(shutter);
    fireEvent.click(shutter);
    await waitFor(() => expect(camera.capturePhoto).toHaveBeenCalledTimes(1));
    await act(async () => captured(photo));
    expect(await screen.findByTestId("camera-photo")).toBeTruthy();
    expect(camera.capturePhoto).toHaveBeenCalledTimes(1);
  });

  it("offers no video mode unless the host can keep a recording", async () => {
    render(<CameraPageView ports={{ keep: { label: "Keep", run: vi.fn() } }} />);
    await screen.findByTestId("camera-capture");
    expect(screen.queryByTestId("camera-mode-video")).toBeNull();
    expect(screen.queryByTestId("camera-record")).toBeNull();
  });

  it("records through the shared session and keeps a video only on an explicit Keep", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge closed"))
      .mockResolvedValueOnce({ status: "saved", id: "v:7" });
    const discard = vi.fn();
    const options = vi.fn(() => ({ audio: true, maxDuration: 60 }));
    render(
      <CameraPageView
        ports={{
          video: { keep: { label: "Keep video", run }, discard, options },
        }}
      />,
    );
    fireEvent.click(await screen.findByTestId("camera-mode-video"));
    fireEvent.click(await screen.findByTestId("camera-record"));
    expect(await screen.findByTestId("camera-recording")).toBeTruthy();
    expect(camera.startRecording).toHaveBeenCalledWith({
      audio: true,
      maxDuration: 60,
    });
    // The mode cannot change mid-recording.
    expect(screen.queryByTestId("camera-mode-photo")).toBeNull();
    fireEvent.click(screen.getByTestId("camera-record"));
    expect((await screen.findByTestId("camera-video")).textContent).toMatch(
      /Video recorded \(3 s\)/,
    );
    expect(camera.stopRecording).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("camera-keep"));
    expect(
      (await screen.findByTestId("camera-keep-status")).textContent,
    ).toMatch(/could not be confirmed/);
    fireEvent.click(screen.getByTestId("camera-keep"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-keep-status").textContent).toBe(
        "Video kept.",
      ),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toEqual(recording);
    // An unknown outcome retries under the same identity.
    expect(run.mock.calls[0][1]).toBe(run.mock.calls[1][1]);
    // A kept recording is never discarded.
    fireEvent.click(screen.getByTestId("camera-retake"));
    expect(discard).not.toHaveBeenCalled();
    expect(await screen.findByTestId("camera-record")).toBeTruthy();
  });

  it("hands a retaken or unkept recording back to the host", async () => {
    const discard = vi.fn();
    const run = vi.fn();
    const view = render(
      <CameraPageView
        ports={{ video: { keep: { label: "Keep video", run }, discard } }}
      />,
    );
    fireEvent.click(await screen.findByTestId("camera-mode-video"));
    fireEvent.click(await screen.findByTestId("camera-record"));
    await screen.findByTestId("camera-recording");
    fireEvent.click(screen.getByTestId("camera-record"));
    await screen.findByTestId("camera-video");
    fireEvent.click(screen.getByTestId("camera-retake"));
    await waitFor(() => expect(discard).toHaveBeenCalledWith(recording));
    // Leaving with a reviewed, unkept recording releases it too.
    fireEvent.click(await screen.findByTestId("camera-record"));
    await screen.findByTestId("camera-recording");
    fireEvent.click(screen.getByTestId("camera-record"));
    await screen.findByTestId("camera-video");
    view.unmount();
    await waitFor(() => expect(discard).toHaveBeenCalledTimes(2));
    expect(run).not.toHaveBeenCalled();
  });

  it("finishes a recording on unmount and never keeps it implicitly", async () => {
    const discard = vi.fn();
    const run = vi.fn();
    const view = render(
      <CameraPageView
        ports={{ video: { keep: { label: "Keep video", run }, discard } }}
      />,
    );
    fireEvent.click(await screen.findByTestId("camera-mode-video"));
    fireEvent.click(await screen.findByTestId("camera-record"));
    await screen.findByTestId("camera-recording");
    view.unmount();
    await waitFor(() => expect(camera.stopRecording).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(discard).toHaveBeenCalledWith(recording));
    expect(run).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed recording and a microphone denial without a review", async () => {
    camera.stopRecording.mockResolvedValueOnce({ ...recording, fileSize: 0 });
    render(
      <CameraPageView
        ports={{ video: { keep: { label: "Keep video", run: vi.fn() } } }}
      />,
    );
    fireEvent.click(await screen.findByTestId("camera-mode-video"));
    fireEvent.click(await screen.findByTestId("camera-record"));
    await screen.findByTestId("camera-recording");
    fireEvent.click(screen.getByTestId("camera-record"));
    expect((await screen.findByTestId("camera-error")).textContent).toBe(
      "The recording could not be saved.",
    );
    expect(screen.queryByTestId("camera-video")).toBeNull();
    camera.startRecording.mockRejectedValueOnce(
      Object.assign(new Error("Microphone permission denied"), {
        code: "MICROPHONE_DENIED",
      }),
    );
    fireEvent.click(screen.getByTestId("camera-record"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-error").textContent).toMatch(
        /Microphone access is off/,
      ),
    );
    expect(screen.queryByTestId("camera-recording")).toBeNull();
  });
});
