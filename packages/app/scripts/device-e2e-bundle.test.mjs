/**
 * Unit coverage for the device-e2e bundle assembler.
 *
 * The real runners need phones/simulators, so this test pins the pure filesystem
 * contract: output directory selection, inline-ready artifact collection,
 * summary writing, and JUnit generation on both passing and failed steps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  runBundledCommand,
  startBundleStep,
} from "./lib/device-e2e-bundle.mjs";

const tempDirs = [];
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const FINALIZED_MP4 = (() => {
  const fileType = Buffer.alloc(12);
  fileType.writeUInt32BE(12, 0);
  fileType.write("ftyp", 4, "ascii");
  fileType.write("isom", 8, "ascii");
  const movie = Buffer.alloc(8);
  movie.writeUInt32BE(8, 0);
  movie.write("moov", 4, "ascii");
  return Buffer.concat([fileType, movie]);
})();

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

  it("writes summary, junit, and inline copies for existing JPG/MP4 artifacts", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
      device: { serial: "device-1" },
      build: { buildId: "build-1", commit: "abc123" },
    });

    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const jpg = path.join(sourceDir, "screen.jpg");
    const mp4 = path.join(sourceDir, "walkthrough.mp4");
    fs.writeFileSync(jpg, "jpg");
    fs.writeFileSync(mp4, FINALIZED_MP4);

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
  });

  it("ingests external media and logs into a self-contained bundle", () => {
    const root = tempRoot();
    const sourceDir = path.join(root, "workflow-evidence");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, "walkthrough.mp4"), FINALIZED_MP4);
    fs.writeFileSync(path.join(sourceDir, "screen.jpg"), "jpg");
    fs.writeFileSync(path.join(sourceDir, "runner.log"), "complete\n");
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "ios-sim",
      outputDir: path.join(root, "bundle"),
      build: { buildId: "build-1", commit: "abc123" },
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
  });

  it("fails a nominally passing bundle when required exact-head evidence is absent", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "ios-sim",
      outputDir: path.join(root, "bundle"),
      build: { buildId: "build-1", commit: null },
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
      "build.commit is missing",
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

  it("rejects a non-empty MP4 that has no finalized movie box", () => {
    const root = tempRoot();
    const bundle = createDeviceE2eBundle({
      appDir: root,
      lane: "android",
      outputDir: path.join(root, "bundle"),
      build: { buildId: "build-1", commit: "abc123" },
    });
    const video = path.join(bundle.rawDir, "interrupted.mp4");
    fs.writeFileSync(video, "not-a-finalized-container");
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
