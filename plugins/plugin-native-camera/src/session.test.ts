/**
 * Contract tests for the shared camera session: epoch-fenced starts, chained stops, explicit
 * denial classification, single-flight recording finalization and exclusive captures.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CameraRecordingReceipt,
  completeRecording,
  createCameraSession,
} from "./session";

const receipt: CameraRecordingReceipt = {
  path: "content://media/external/video/media/7",
  duration: 2,
  fileSize: 4096,
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(
  overrides: Partial<{
    startPreview: () => Promise<unknown>;
    stopPreview: () => Promise<unknown>;
    startRecording: () => Promise<unknown>;
    stopRecording: () => Promise<CameraRecordingReceipt>;
  }> = {},
) {
  let active = true;
  let available = true;
  const calls: string[] = [];
  const hooks = {
    recordingFinishing: vi.fn(),
    recordingSaved: vi.fn(),
    recordingFailed: vi.fn(),
    changed: vi.fn(),
  };
  const camera = {
    startPreview: vi.fn(async (options: { direction: string }) => {
      calls.push(`start:${options.direction}`);
      return overrides.startPreview?.();
    }),
    stopPreview: vi.fn(async () => {
      calls.push("stop");
      return overrides.stopPreview?.();
    }),
    startRecording: vi.fn(async (options: { audio: boolean }) => {
      calls.push(`record:${options.audio}`);
      return overrides.startRecording?.();
    }),
    stopRecording: vi.fn(async () => {
      calls.push("finish");
      return overrides.stopRecording ? overrides.stopRecording() : receipt;
    }),
  };
  const session = createCameraSession({
    camera,
    active: () => active,
    available: () => available,
    preview: () => ({ direction: "back" }),
    recording: () => ({ audio: true }),
    hooks,
  });
  return {
    session,
    camera,
    calls,
    hooks,
    setActive(value: boolean) {
      active = value;
    },
    setAvailable(value: boolean) {
      available = value;
    },
  };
}

describe("completeRecording", () => {
  it("accepts only a receipt with a path, duration and size", () => {
    expect(completeRecording(receipt)).toBe(true);
    for (const bad of [
      null,
      {},
      { ...receipt, path: "" },
      { ...receipt, duration: 0 },
      { ...receipt, fileSize: 0 },
      { ...receipt, duration: Number.NaN },
      { ...receipt, fileSize: "4096" },
    ])
      expect(completeRecording(bad)).toBe(false);
  });
});

describe("createCameraSession start", () => {
  it("starts once and reports ready", async () => {
    const h = harness();
    expect(await h.session.start()).toEqual({ status: "ready" });
    expect(h.session.phase).toBe("ready");
    expect(await h.session.start()).toEqual({ status: "skipped" });
    expect(h.camera.startPreview).toHaveBeenCalledTimes(1);
    expect(h.hooks.changed).toHaveBeenCalled();
  });

  it("classifies only an explicit denial and never retries an error on its own", async () => {
    let fail: unknown = { code: "CAMERA_PERMISSION_DENIED" };
    const h = harness({
      startPreview: async () => {
        if (fail) throw fail;
      },
    });
    expect(await h.session.start()).toEqual({ status: "denied" });
    expect(h.session.denied).toBe("camera");
    expect(h.session.phase).toBe("error");
    expect(await h.session.start()).toEqual({ status: "skipped" });
    fail = new Error("hardware busy");
    expect(await h.session.start(true)).toEqual({
      status: "unavailable",
      reason: "failed",
      error: fail,
    });
    expect(h.session.denied).toBeUndefined();
    fail = undefined;
    expect(await h.session.start(true)).toEqual({ status: "ready" });
    expect(h.camera.startPreview).toHaveBeenCalledTimes(3);
  });

  it("clears a camera denial once a preview starts", async () => {
    let denied = true;
    const h = harness({
      startPreview: async () => {
        if (denied) throw { name: "NotAllowedError" };
      },
    });
    await h.session.start();
    denied = false;
    h.session.rearm();
    expect(h.session.phase).toBe("off");
    expect(await h.session.start()).toEqual({ status: "ready" });
    expect(h.session.denied).toBeUndefined();
  });

  it("reports a missing bridge without calling it", async () => {
    const h = harness();
    h.setAvailable(false);
    expect(await h.session.start()).toEqual({
      status: "unavailable",
      reason: "missing",
    });
    expect(h.camera.startPreview).not.toHaveBeenCalled();
    expect(h.session.phase).toBe("error");
  });

  it("does not start for an inactive surface", async () => {
    const h = harness();
    h.setActive(false);
    expect(await h.session.start()).toEqual({ status: "skipped" });
    expect(h.camera.startPreview).not.toHaveBeenCalled();
  });

  it("a stop during a start makes the start stale, and the next start waits for the release", async () => {
    const preview = deferred();
    const release = deferred();
    let first = true;
    const h = harness({
      startPreview: () => (first ? preview.promise : Promise.resolve()),
      stopPreview: () => release.promise,
    });
    const starting = h.session.start();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = h.session.stop();
    first = false;
    preview.resolve();
    expect(await starting).toEqual({ status: "stale" });
    expect(h.session.phase).toBe("off");
    const restart = h.session.start();
    await Promise.resolve();
    expect(h.camera.startPreview).toHaveBeenCalledTimes(1);
    release.resolve();
    await stopping;
    expect(await restart).toEqual({ status: "ready" });
    // The late preview is released before the new start runs.
    expect(h.calls).toEqual(["start:back", "stop", "stop", "start:back"]);
  });

  it("a preview that comes up after the surface closed is released", async () => {
    const preview = deferred();
    const h = harness({ startPreview: () => preview.promise });
    const starting = h.session.start();
    await Promise.resolve();
    await h.session.stop();
    preview.resolve();
    expect(await starting).toEqual({ status: "stale" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls).toEqual(["start:back", "stop", "stop"]);
  });

  it("a surface that hid while starting releases its late preview and can start again", async () => {
    const preview = deferred();
    let late = true;
    const h = harness({
      startPreview: () => (late ? preview.promise : Promise.resolve()),
    });
    const starting = h.session.start();
    await Promise.resolve();
    h.setActive(false);
    preview.resolve();
    expect(await starting).toEqual({ status: "stale" });
    expect(h.session.phase).toBe("off");
    late = false;
    h.setActive(true);
    expect(await h.session.start()).toEqual({ status: "ready" });
    expect(h.calls).toEqual(["start:back", "stop", "start:back"]);
  });

  it("a failed start after a stop is stale, not an error", async () => {
    const preview = deferred();
    const h = harness({ startPreview: () => preview.promise });
    const starting = h.session.start();
    await Promise.resolve();
    await h.session.stop();
    preview.reject({ code: "CAMERA_PERMISSION_DENIED" });
    expect(await starting).toEqual({ status: "stale" });
    expect(h.session.denied).toBeUndefined();
    expect(h.session.phase).toBe("off");
  });

  it("a failed release never blocks the next start", async () => {
    const h = harness({
      stopPreview: async () => {
        throw new Error("already stopped");
      },
    });
    await h.session.start();
    await h.session.stop();
    expect(await h.session.start()).toEqual({ status: "ready" });
  });
});

describe("createCameraSession controls and captures", () => {
  it("runs one control at a time and only while ready", async () => {
    const h = harness();
    expect(await h.session.control(async () => {})).toBe("skipped");
    await h.session.start();
    const gate = deferred();
    const first = h.session.control(() => gate.promise);
    expect(h.session.controlBusy).toBe(true);
    expect(await h.session.control(async () => {})).toBe("skipped");
    gate.resolve();
    expect(await first).toBe("done");
    expect(
      await h.session.control(async () => {
        throw new Error("unsupported");
      }),
    ).toBe("failed");
    expect(h.session.controlBusy).toBe(false);
  });

  it("a control that finishes after the surface closed is stale", async () => {
    const h = harness();
    await h.session.start();
    const gate = deferred();
    const pending = h.session.control(() => gate.promise);
    await h.session.stop();
    gate.resolve();
    expect(await pending).toBe("stale");
  });

  it("runs captures exclusively", async () => {
    const h = harness();
    await h.session.start();
    const gate = deferred<string>();
    const first = h.session.exclusive(() => gate.promise);
    expect(h.session.capturing).toBe(true);
    expect(await h.session.exclusive(async () => "second")).toEqual({
      status: "busy",
    });
    expect(await h.session.control(async () => {})).toBe("skipped");
    expect(await h.session.startRecording()).toBe("skipped");
    gate.resolve("first");
    expect(await first).toEqual({ status: "done", value: "first" });
    expect(h.session.capturing).toBe(false);
    await expect(
      h.session.exclusive(async () => {
        throw new Error("lost");
      }),
    ).rejects.toThrow("lost");
    expect(h.session.capturing).toBe(false);
  });
});

describe("createCameraSession recording", () => {
  it("records, then finalizes once and hands the receipt to the host", async () => {
    const h = harness();
    await h.session.start();
    expect(await h.session.startRecording()).toBe("recording");
    expect(h.session.recording).toBe(true);
    const [a, b] = [h.session.finishRecording(), h.session.finishRecording()];
    expect(h.session.finalizing).toBe(true);
    expect(await a).toBe("saved");
    expect(await b).toBe("saved");
    expect(h.camera.stopRecording).toHaveBeenCalledTimes(1);
    expect(h.hooks.recordingFinishing).toHaveBeenCalledTimes(1);
    expect(h.hooks.recordingSaved).toHaveBeenCalledWith(receipt);
    expect(h.session.recording).toBe(false);
    expect(h.session.finalizing).toBe(false);
  });

  it("never claims an incomplete or rejected recording", async () => {
    const h = harness({
      stopRecording: async () => ({ ...receipt, fileSize: 0 }),
    });
    await h.session.start();
    await h.session.startRecording();
    expect(await h.session.finishRecording()).toBe("failed");
    expect(h.hooks.recordingSaved).not.toHaveBeenCalled();
    expect(h.hooks.recordingFailed).toHaveBeenCalledTimes(1);

    const g = harness();
    g.hooks.recordingSaved.mockRejectedValueOnce(new Error("not in library"));
    await g.session.start();
    await g.session.startRecording();
    expect(await g.session.finishRecording()).toBe("failed");
    expect(g.hooks.recordingFailed).toHaveBeenCalledTimes(1);
  });

  it("classifies a microphone denial", async () => {
    const h = harness({
      startRecording: async () => {
        throw { code: "MICROPHONE_DENIED" };
      },
    });
    await h.session.start();
    expect(await h.session.startRecording()).toBe("denied");
    expect(h.session.denied).toBe("microphone");
    expect(h.session.recording).toBe(false);
    h.session.clearDenied("camera");
    expect(h.session.denied).toBe("microphone");
    h.session.clearDenied("microphone");
    expect(h.session.denied).toBeUndefined();
    const g = harness({
      startRecording: async () => {
        throw new Error("encoder");
      },
    });
    await g.session.start();
    expect(await g.session.startRecording()).toBe("failed");
    expect(g.session.denied).toBeUndefined();
  });

  it("stopping the surface finishes an active recording before releasing the preview", async () => {
    const h = harness();
    await h.session.start();
    await h.session.startRecording();
    await h.session.stop();
    expect(h.calls).toEqual(["start:back", "record:true", "finish", "stop"]);
    expect(h.hooks.recordingSaved).toHaveBeenCalledTimes(1);
  });

  it("a recording that starts after the surface closed is finished, not left running", async () => {
    const gate = deferred();
    const h = harness({ startRecording: () => gate.promise });
    await h.session.start();
    const starting = h.session.startRecording();
    expect(h.session.recordingStarting).toBe(true);
    expect(await h.session.start(true)).toEqual({ status: "skipped" });
    h.setActive(false);
    gate.resolve();
    expect(await starting).toBe("stale");
    expect(h.camera.stopRecording).toHaveBeenCalledTimes(1);
    expect(h.session.recording).toBe(false);
    expect(h.session.recordingStarting).toBe(false);
  });

  it("does not start a preview while a recording is finalizing", async () => {
    const gate = deferred<CameraRecordingReceipt>();
    const h = harness({ stopRecording: () => gate.promise });
    await h.session.start();
    await h.session.startRecording();
    const stopping = h.session.stop();
    expect(await h.session.start()).toEqual({ status: "skipped" });
    gate.resolve(receipt);
    await stopping;
    expect(await h.session.start()).toEqual({ status: "ready" });
  });
});
