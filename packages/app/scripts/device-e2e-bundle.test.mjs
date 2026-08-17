/**
 * Unit coverage for the device-e2e bundle assembler.
 *
 * The real runners need phones/simulators, so this test pins the pure filesystem
 * contract: output directory selection, inline-ready artifact collection,
 * summary writing, and JUnit generation on both passing and failed steps.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactBundleCommit,
  captureFailureForensics,
  collectBundleArtifacts,
  createDeviceE2eBundle,
  defaultDeviceE2eOutputDir,
  finalizeDeviceE2eBundle,
  finishBundleStep,
  formatFailureForensicsBlock,
  getDeviceE2eBundleFinalizationError,
  parseOutputDirArg,
  recordBundleArtifact,
  recordBundleRunnerFailure,
  resolveBundleExpectedCommit,
  runBundledCommand,
  startBundleStep,
} from "./lib/device-e2e-bundle.mjs";
import {
  isRenderableVideo,
  resolveMediaProbeBinary,
} from "./lib/device-video.mjs";

const tempDirs = [];
const EXPECTED_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const STALE_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJ/AB//Z",
  "base64",
);

function mp4Box(type, payload = Buffer.alloc(0)) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

const EMPTY_MP4_SHELL = Buffer.concat([
  mp4Box("ftyp", Buffer.from("isom")),
  mp4Box("moov"),
]);
const UNDECODABLE_MP4 = Buffer.concat([
  mp4Box("ftyp", Buffer.from("isom")),
  mp4Box("moov"),
  mp4Box("mdat", Buffer.from("not-a-video-frame")),
]);

function writePlayableH264Mp4(outputPath) {
  const ffmpeg = resolveMediaProbeBinary();
  if (!ffmpeg) {
    throw new Error("ffmpeg is required to generate the H.264 test fixture");
  }
  const result = spawnSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=16x16:r=1:d=3",
      "-frames:v",
      "3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not generate H.264 fixture: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return outputPath;
}

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "device-e2e-bundle-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("device-e2e bundle assembly", () => {
  it("parses --output and builds the default per-lane directory", () => {
    expect(parseOutputDirArg(["node", "runner", "--output", "/tmp/out"])).toBe(
      "/tmp/out",
    );
    expect(parseOutputDirArg(["node", "runner"])).toBeUndefined();
    expect(
      defaultDeviceE2eOutputDir({
        appDir: "/repo/packages/app",
        lane: "android",
        date: new Date("2026-07-05T01:02:03.004Z"),
      }),
    ).toBe(
      "/repo/packages/app/device-e2e-output/android-2026-07-05T01-02-03-004Z",
    );
  });

  it("resolves and enforces one immutable full repository commit", () => {
    const calls = [];
    expect(
      resolveBundleExpectedCommit("/repo/packages/app", {
        execFileSync: (command, args, options) => {
          calls.push({ command, args, options });
          return `${EXPECTED_COMMIT.toUpperCase()}\n`;
        },
      }),
    ).toBe(EXPECTED_COMMIT);
    expect(calls).toEqual([
      {
        command: "git",
        args: ["rev-parse", "HEAD"],
        options: expect.objectContaining({ cwd: "/repo/packages/app" }),
      },
    ]);
    expect(
      resolveBundleExpectedCommit("/repo", {
        execFileSync: () => "short\n",
      }),
    ).toBeNull();
    expect(
      resolveBundleExpectedCommit("/repo", {
        execFileSync: () => {
          throw new Error("git unavailable");
        },
      }),
    ).toBeNull();
    expect(assertExactBundleCommit(EXPECTED_COMMIT, EXPECTED_COMMIT)).toBe(
      EXPECTED_COMMIT,
    );
  });

  it("writes summary, junit, and inline copies for existing JPG/MP4 artifacts", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
      device: { serial: "device-1" },
      build: { buildId: "build-1", commit: EXPECTED_COMMIT },
      expectedCommit: EXPECTED_COMMIT,
    });

    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const jpg = path.join(sourceDir, "screen.jpg");
    const mp4 = path.join(sourceDir, "walkthrough.mp4");
    fs.writeFileSync(jpg, TINY_JPEG);
    writePlayableH264Mp4(mp4);

    const step = startBundleStep(bundle, "route coverage");
    recordBundleArtifact(bundle, jpg, "screenshot", step);
    recordBundleArtifact(bundle, mp4, "video", step);
    finishBundleStep(bundle, step, "passed");

    const logPath = path.join(bundle.logsDir, "runner.log");
    fs.writeFileSync(logPath, "complete\n");
    const bundleRoot = finalizeDeviceE2eBundle(bundle, "passed", {
      requiredEvidence: {
        buildId: true,
        commit: true,
        inlineScreenshot: true,
        inlineVideo: true,
        logs: true,
      },
    });
    const summary = JSON.parse(
      fs.readFileSync(path.join(bundleRoot, "summary.json"), "utf8"),
    );

    expect(summary.result).toBe("passed");
    expect(summary.device.serial).toBe("device-1");
    expect(summary.build.buildId).toBe("build-1");
    expect(summary.build.commit).toBe(EXPECTED_COMMIT);
    expect(summary.build.expectedCommit).toBe(EXPECTED_COMMIT);
    expect(summary.steps).toHaveLength(1);
    expect(fs.existsSync(path.join(bundleRoot, "junit.xml"))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, "inline", "screen.jpg"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(bundleRoot, "inline", "walkthrough.mp4")),
    ).toBe(true);
    expect(summary.validationErrors).toEqual([]);
    expect(
      summary.artifacts.every((artifact) => !artifact.path.startsWith("..")),
    ).toBe(true);
    expect(getDeviceE2eBundleFinalizationError(bundle)).toBeNull();
  }, 60_000);

  it("ingests external media and logs into a self-contained bundle", () => {
    const root = tempRoot();
    const sourceDir = path.join(root, "workflow-evidence");
    fs.mkdirSync(sourceDir);
    writePlayableH264Mp4(path.join(sourceDir, "walkthrough.mp4"));
    fs.writeFileSync(path.join(sourceDir, "screen.jpg"), TINY_JPEG);
    fs.writeFileSync(path.join(sourceDir, "runner.log"), "complete\n");
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "ios-sim",
      outputDir: path.join(root, "bundle"),
      build: { buildId: "build-1", commit: EXPECTED_COMMIT },
      expectedCommit: EXPECTED_COMMIT,
    });
    const step = startBundleStep(bundle, "simulator smoke");
    finishBundleStep(bundle, step, "passed");

    finalizeDeviceE2eBundle(bundle, "passed", {
      sourceDirs: [sourceDir],
      requiredEvidence: {
        buildId: true,
        commit: true,
        inlineScreenshot: true,
        inlineVideo: true,
        logs: true,
      },
    });

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    expect(summary.result).toBe("passed");
    expect(fs.existsSync(path.join(bundle.rawDir, "walkthrough.mp4"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(bundle.rawDir, "screen.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(bundle.logsDir, "runner.log"))).toBe(true);
    expect(fs.existsSync(path.join(bundle.inlineDir, "walkthrough.mp4"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(bundle.inlineDir, "screen.jpg"))).toBe(true);
    expect(
      summary.artifacts.every((artifact) => !artifact.path.startsWith("..")),
    ).toBe(true);
  }, 60_000);

  it("fails a nominally passing bundle when required exact-head evidence is absent", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "ios-sim",
      outputDir: path.join(root, "bundle"),
      build: { buildId: "build-1", commit: null },
      expectedCommit: EXPECTED_COMMIT,
    });
    const step = startBundleStep(bundle, "simulator smoke");
    finishBundleStep(bundle, step, "passed");

    finalizeDeviceE2eBundle(bundle, "passed", {
      requiredEvidence: {
        buildId: true,
        commit: true,
        inlineScreenshot: true,
        inlineVideo: true,
        logs: true,
      },
    });

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    const junit = fs.readFileSync(path.join(bundle.root, "junit.xml"), "utf8");
    expect(summary.result).toBe("failed");
    expect(summary.validationErrors).toEqual([
      "build.commit is missing or is not a full SHA-1",
      "inline JPG screenshot is missing",
      "inline MP4 walkthrough is missing",
      "logs/ has no non-empty log",
    ]);
    expect(summary.steps.at(-1)).toMatchObject({
      name: "validate evidence bundle",
      status: "failed",
    });
    expect(junit).toContain('failures="1"');
    expect(getDeviceE2eBundleFinalizationError(bundle)?.message).toContain(
      "device evidence bundle is incomplete",
    );
  });

  it.each([
    [
      "a malformed commit",
      "not-a-sha",
      "build.commit is missing or is not a full SHA-1",
    ],
    [
      "a stale commit",
      STALE_COMMIT,
      `build.commit ${STALE_COMMIT} does not match expected HEAD ${EXPECTED_COMMIT}`,
    ],
  ])(
    "rejects %s when exact-head evidence is required",
    (_case, commit, error) => {
      const root = tempRoot();
      const bundle = createDeviceE2eBundle({
        appDir: root,
        lane: "android",
        outputDir: path.join(root, "bundle"),
        build: { buildId: "build-1", commit },
        expectedCommit: EXPECTED_COMMIT,
      });

      finalizeDeviceE2eBundle(bundle, "passed", {
        requiredEvidence: { commit: true },
      });

      const summary = JSON.parse(
        fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
      );
      expect(summary.result).toBe("failed");
      expect(summary.validationErrors).toEqual([error]);
    },
  );

  it.each([
    ["arbitrary bytes", Buffer.from("jpg")],
    ["a truncated JPEG signature", Buffer.from([0xff, 0xd8, 0xff])],
  ])("rejects %s as inline JPEG evidence", (_case, contents) => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
    });
    const screenshot = path.join(bundle.rawDir, "invalid.jpg");
    fs.writeFileSync(screenshot, contents);
    recordBundleArtifact(bundle, screenshot, "screenshot");

    finalizeDeviceE2eBundle(bundle, "passed", {
      requiredEvidence: { inlineScreenshot: true },
    });

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    expect(summary.result).toBe("failed");
    expect(summary.validationErrors).toEqual([
      "inline JPG screenshot is missing",
    ]);
    expect(fs.readdirSync(bundle.inlineDir)).toEqual([]);
    expect(summary.warnings).toEqual([
      `could not publish unrenderable JPEG inline: ${screenshot}`,
    ]);
  });

  it.each([
    ["a non-H.264 stream", "hevc", 3, 3, 16, 16],
    ["a zero-duration stream", "h264", 0, 3, 16, 16],
    ["a too-short stream", "h264", 0.067, 3, 16, 16],
    ["a one-frame stream", "h264", 3, 1, 16, 16],
    ["a zero-width stream", "h264", 3, 3, 0, 16],
  ])(
    "rejects %s even when a decoder would return success",
    (_case, codecName, duration, frameCount, width, height) => {
      const root = tempRoot();
      const video = path.join(root, "metadata-only.mp4");
      fs.writeFileSync(video, "non-empty");
      const spawnCalls = [];
      const spawnSyncStub = (command) => {
        spawnCalls.push(command);
        if (command === "ffprobe") {
          return {
            status: 0,
            stdout: JSON.stringify({
              streams: [
                {
                  codec_name: codecName,
                  duration: String(duration),
                  nb_read_frames: String(frameCount),
                  width,
                  height,
                },
              ],
              format: { duration: String(duration) },
            }),
          };
        }
        return { status: 0 };
      };

      expect(
        isRenderableVideo(video, {
          metadataProbeBinary: "ffprobe",
          probeBinary: "ffmpeg",
          spawnSync: spawnSyncStub,
        }),
      ).toBe(false);
      expect(spawnCalls).toEqual(["ffprobe"]);
    },
  );

  it("requires both positive H.264 metadata and a decodable frame", () => {
    const root = tempRoot();
    const video = path.join(root, "valid.mp4");
    fs.writeFileSync(video, "non-empty");
    const spawnCalls = [];
    const spawnSyncStub = (command) => {
      spawnCalls.push(command);
      return command === "ffprobe"
        ? {
            status: 0,
            stdout: JSON.stringify({
              streams: [
                {
                  codec_name: "h264",
                  duration: "N/A",
                  nb_read_frames: "3",
                  width: 16,
                  height: 16,
                },
              ],
              format: { duration: "3" },
            }),
          }
        : { status: 0 };
    };

    expect(
      isRenderableVideo(video, {
        metadataProbeBinary: "ffprobe",
        probeBinary: "ffmpeg",
        spawnSync: spawnSyncStub,
      }),
    ).toBe(true);
    expect(spawnCalls).toEqual(["ffprobe", "ffmpeg"]);
  });

  it.each([
    ["an empty ftyp+moov shell", EMPTY_MP4_SHELL],
    ["a structurally plausible but non-decodable container", UNDECODABLE_MP4],
  ])("rejects %s as inline MP4 evidence", (_case, contents) => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
    });
    const video = path.join(bundle.rawDir, "invalid.mp4");
    fs.writeFileSync(video, contents);
    recordBundleArtifact(bundle, video, "video");

    finalizeDeviceE2eBundle(bundle, "passed", {
      requiredEvidence: { inlineVideo: true },
    });

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    expect(summary.result).toBe("failed");
    expect(summary.validationErrors).toEqual([
      "inline MP4 walkthrough is missing",
    ]);
    expect(fs.readdirSync(bundle.inlineDir)).toEqual([]);
    expect(summary.warnings).toEqual([
      `could not publish unfinalized MP4 inline: ${video}`,
    ]);
  });

  it("collects logs from source directories and records failed steps in junit", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "ios-sim",
      outputDir: path.join(root, "bundle"),
    });
    const logDir = path.join(root, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "runner.log"), "failed\n");

    const step = startBundleStep(bundle, "local chat");
    finishBundleStep(bundle, step, "failed", new Error("chat failed"));
    collectBundleArtifacts(bundle, [logDir]);
    finalizeDeviceE2eBundle(bundle, "failed");

    const junit = fs.readFileSync(path.join(bundle.root, "junit.xml"), "utf8");
    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    expect(junit).toContain('failures="1"');
    expect(junit).toContain("chat failed");
    expect(summary.result).toBe("failed");
    expect(summary.artifacts.some((a) => a.path.endsWith("runner.log"))).toBe(
      true,
    );
  });

  it("converts PNG screenshots into inline JPG artifacts", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
    });
    const png = path.join(bundle.rawDir, "screen.png");
    fs.writeFileSync(png, ONE_BY_ONE_PNG);
    recordBundleArtifact(bundle, png, "screenshot");

    finalizeDeviceE2eBundle(bundle, "passed");

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    expect(fs.existsSync(path.join(bundle.inlineDir, "screen.jpg"))).toBe(true);
    expect(summary.artifacts.some((a) => a.path === "inline/screen.jpg")).toBe(
      true,
    );
  });

  it("writes a failed summary and runner log when a bundled command fails", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
    });

    expect(() =>
      runBundledCommand(
        bundle,
        "failing command",
        process.execPath,
        ["-e", "console.error('nope'); process.exit(7)"],
        { cwd: root },
      ),
    ).toThrow(/exited with code 7/);
    finalizeDeviceE2eBundle(bundle, "failed");

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    expect(summary.result).toBe("failed");
    expect(summary.steps[0]).toMatchObject({
      name: "failing command",
      status: "failed",
    });
    expect(
      fs.readFileSync(path.join(bundle.logsDir, "runner.log"), "utf8"),
    ).toContain("nope");
  });

  it("bounds bundled commands and records a precise timeout failure", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
    });

    expect(() =>
      runBundledCommand(
        bundle,
        "bounded command",
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        { cwd: root, timeoutMs: 50 },
      ),
    ).toThrow(/timed out after 50ms/);

    expect(bundle.steps[0]).toMatchObject({
      name: "bounded command",
      status: "failed",
      error: expect.stringContaining("timed out after 50ms"),
    });
  });

  it("records an unhandled runner failure as a failed junit step", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "ios-sim",
      outputDir: path.join(root, "bundle"),
    });
    recordBundleRunnerFailure(bundle, new Error("simulator disappeared"));
    finalizeDeviceE2eBundle(bundle, "failed");

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    const junit = fs.readFileSync(path.join(bundle.root, "junit.xml"), "utf8");
    expect(summary.steps[0]).toMatchObject({
      name: "runner failure",
      status: "failed",
      error: "simulator disappeared",
    });
    expect(junit).toContain('failures="1"');
    expect(
      fs.readFileSync(path.join(bundle.logsDir, "runner.log"), "utf8"),
    ).toContain("runner failure: simulator disappeared");
  });

  it("records step failure forensics and formats a compact stderr block", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
    });
    const step = startBundleStep(bundle, "Android route coverage");
    const error = new Error("route failed");

    captureFailureForensics(
      bundle,
      step,
      ({ failureDir }) => {
        const cause = path.join(failureDir, "failure-cause.txt");
        const log = path.join(failureDir, "logcat.txt");
        const screen = path.join(failureDir, "screen.png");
        fs.writeFileSync(cause, "route failed\n");
        fs.writeFileSync(log, "log tail\n");
        fs.writeFileSync(screen, ONE_BY_ONE_PNG);
        return [cause, log, screen];
      },
      error,
    );
    finishBundleStep(bundle, step, "failed", error);
    finalizeDeviceE2eBundle(bundle, "failed");

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    const block = formatFailureForensicsBlock(bundle, error);

    expect(summary.steps[0].failureDir).toBe("failure/android-route-coverage");
    expect(summary.steps[0].artifacts).toEqual([
      "failure/android-route-coverage/failure-cause.txt",
      "failure/android-route-coverage/logcat.txt",
      "failure/android-route-coverage/screen.png",
    ]);
    expect(block).toContain("DEVICE E2E FAILURE FORENSICS");
    expect(block).toContain("step: Android route coverage");
    expect(block).toContain("screen.png");
  });

  it("keeps the original failed step when forensic capture fails", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "ios-sim",
      outputDir: path.join(root, "bundle"),
    });
    const step = startBundleStep(bundle, "boot iOS Simulator");

    captureFailureForensics(bundle, step, () => {
      throw new Error("simulator disconnected");
    });
    finishBundleStep(bundle, step, "failed", new Error("boot failed"));
    finalizeDeviceE2eBundle(bundle, "failed");

    const summary = JSON.parse(
      fs.readFileSync(path.join(bundle.root, "summary.json"), "utf8"),
    );
    expect(summary.result).toBe("failed");
    expect(summary.steps[0].error).toBe("boot failed");
    expect(summary.warnings[0]).toContain("simulator disconnected");
  });
});
