import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  default: { promises: fsMock.promises },
  promises: fsMock.promises,
}));
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { default: actual, ...actual };
});

import { FileBridgeCameraSource } from "./file-bridge-camera";

const ORIGINAL_ROOT = process.env.AGENT_ROOT;

function bridgeReads(
  overrides: {
    ack?: () => Promise<string>;
    error?: () => Promise<string>;
    frame?: () => Promise<Buffer>;
  } = {},
) {
  let requestId = "";
  fsMock.promises.writeFile.mockImplementation((p: string, content: string) => {
    if (String(p).endsWith("capture.req")) requestId = String(content);
    return Promise.resolve();
  });
  fsMock.promises.readFile.mockImplementation((p: string) => {
    const path = String(p);
    if (path.endsWith("capture.ack")) {
      if (overrides.ack) return overrides.ack();
      return Promise.resolve(requestId);
    }
    if (path.endsWith("capture.err")) {
      if (overrides.error) return overrides.error();
      return Promise.reject(new Error("ENOENT"));
    }
    if (path.endsWith("capture.jpg")) {
      if (overrides.frame) return overrides.frame();
      return Promise.resolve(Buffer.from("jpeg-bytes"));
    }
    return Promise.reject(new Error("ENOENT"));
  });
  return () => requestId;
}

describe("file bridge camera", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;

  function fixedClock(): void {
    dateNowSpy?.mockRestore();
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  }

  beforeEach(() => {
    process.env.AGENT_ROOT = "/agent";
    fsMock.promises.mkdir.mockClear();
    fsMock.promises.rm.mockClear();
    fsMock.promises.writeFile.mockClear();
    fsMock.promises.readFile.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
    dateNowSpy = undefined;
    if (ORIGINAL_ROOT === undefined) delete process.env.AGENT_ROOT;
    else process.env.AGENT_ROOT = ORIGINAL_ROOT;
  });

  describe("parseBridgeError", () => {
    it("parses a well-formed error ack", async () => {
      // via capture: error sidecar with matching shape must fail the capture
      const source = new FileBridgeCameraSource();
      const getRequestId = bridgeReads({
        error: () =>
          Promise.resolve(
            JSON.stringify({
              id: getRequestId(),
              code: "NO_CAMERA",
              message: "camera busy",
            }),
          ),
        ack: () => Promise.reject(new Error("ENOENT")),
      });
      // id is `${Date.now()}-1` — force a fixed clock so we can name the request
      fixedClock();
      const err = await source.captureJpeg().catch((e: Error) => e);
      expect(err.message).toBe(
        `Camera bridge failed (NO_CAMERA) for request ${getRequestId()}: camera busy`,
      );
    });

    it("ignores an error ack whose id does not match the in-flight request", async () => {
      const source = new FileBridgeCameraSource();
      bridgeReads({
        error: () =>
          Promise.resolve(
            JSON.stringify({
              id: "stale-9",
              code: "NO_CAMERA",
              message: "old",
            }),
          ),
      });
      const frame = await source.captureJpeg();
      expect(frame.toString()).toBe("jpeg-bytes");
    });

    it("ignores a malformed error sidecar (untrusted WebView input) and still succeeds", async () => {
      const source = new FileBridgeCameraSource();
      bridgeReads({
        error: () => Promise.resolve("{not json"),
      });
      const frame = await source.captureJpeg();
      expect(frame.toString()).toBe("jpeg-bytes");
    });

    it("ignores an error sidecar with a non-string code", async () => {
      const source = new FileBridgeCameraSource();
      bridgeReads({
        error: () =>
          Promise.resolve(
            JSON.stringify({ id: "x", code: 42, message: "nope" }),
          ),
      });
      const frame = await source.captureJpeg();
      expect(frame.toString()).toBe("jpeg-bytes");
    });
  });

  describe("captureJpeg", () => {
    it("returns the frame when the ack matches the in-flight request id", async () => {
      const source = new FileBridgeCameraSource();
      bridgeReads();
      const frame = await source.captureJpeg();
      expect(frame.toString()).toBe("jpeg-bytes");
      // the request id is written before polling starts
      expect(fsMock.promises.writeFile).toHaveBeenCalledWith(
        "/agent/vision-bridge/capture.req",
        expect.stringMatching(/^\d+-\d+$/),
        "utf8",
      );
    });

    it("ignores a stale ack from a previous request (single-flight by id)", async () => {
      const source = new FileBridgeCameraSource();
      let ackReads = 0;
      const getRequestId = bridgeReads({
        ack: () => {
          // first read returns the previous request's ack, then the real one
          ackReads += 1;
          return Promise.resolve(ackReads === 1 ? "stale-7" : getRequestId());
        },
      });
      const frame = await source.captureJpeg();
      expect(frame.toString()).toBe("jpeg-bytes");
      expect(ackReads).toBeGreaterThan(1);
    });

    it("fails fast on a matching error ack without waiting for the deadline", async () => {
      const source = new FileBridgeCameraSource();
      let errReads = 0;
      const getRequestId = bridgeReads({
        ack: () => Promise.reject(new Error("ENOENT")),
        error: () => {
          errReads += 1;
          return Promise.resolve(
            JSON.stringify({
              id: getRequestId(),
              code: "DENIED",
              message: "permission",
            }),
          );
        },
      });
      fixedClock();
      const err = await source.captureJpeg().catch((e: Error) => e);
      expect(err.message).toMatch(/Camera bridge failed \(DENIED\)/);
      expect(errReads).toBe(1);
    });

    it("clears stale ack/error sidecars before issuing a new request", async () => {
      const source = new FileBridgeCameraSource();
      bridgeReads();
      await source.captureJpeg();
      expect(fsMock.promises.rm).toHaveBeenCalledWith(
        "/agent/vision-bridge/capture.ack",
        { force: true },
      );
      expect(fsMock.promises.rm).toHaveBeenCalledWith(
        "/agent/vision-bridge/capture.err",
        { force: true },
      );
    });

    it("times out with a descriptive error when the responder never answers", async () => {
      vi.useFakeTimers();
      const source = new FileBridgeCameraSource();
      bridgeReads({
        ack: () => Promise.reject(new Error("ENOENT")),
      });
      const promise = source.captureJpeg();
      const assertion = expect(promise).rejects.toThrow(
        /Camera bridge timed out after 12000ms/,
      );
      await vi.advanceTimersByTimeAsync(13_000);
      await assertion;
    });

    it("monotonic seq gives each capture a distinct request id", async () => {
      fixedClock();
      const source = new FileBridgeCameraSource();
      bridgeReads();
      await source.captureJpeg();
      await source.captureJpeg();
      const writes = fsMock.promises.writeFile.mock.calls
        .filter((c) => String(c[0]).endsWith("capture.req"))
        .map((c) => String(c[1]));
      expect(writes).toEqual(["1700000000000-1", "1700000000000-2"]);
    });
  });
});
