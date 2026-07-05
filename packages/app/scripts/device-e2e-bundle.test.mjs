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
  parseOutputDirArg,
  recordBundleArtifact,
  runBundledCommand,
  startBundleStep,
} from "./lib/device-e2e-bundle.mjs";

const tempDirs = [];
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

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
    fs.writeFileSync(mp4, "mp4");

    const step = startBundleStep(bundle, "route coverage");
    recordBundleArtifact(bundle, jpg, "screenshot", step);
    recordBundleArtifact(bundle, mp4, "video", step);
    finishBundleStep(bundle, step, "passed");

    const bundleRoot = finalizeDeviceE2eBundle(bundle, "passed");
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
