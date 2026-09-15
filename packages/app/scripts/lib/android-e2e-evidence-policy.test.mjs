/** Exercises the Android physical-evidence privacy boundary with adversarial device diagnostics. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createAndroidEvidenceBoundary,
  projectAndroidDeviceEvidenceBundle,
  settleAndroidEvidenceTeardown,
} from "./android-e2e-evidence-policy.mjs";

const roots = [];
const ffmpegAvailable =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "android-evidence-policy-"),
  );
  roots.push(root);
  return root;
}

function allPublicBytes(root) {
  return Buffer.concat(
    fs
      .readdirSync(root, { recursive: true })
      .map((entry) => path.join(root, entry))
      .filter((entry) => fs.statSync(entry).isFile())
      .map((entry) => fs.readFileSync(entry)),
  ).toString("utf8");
}

describe("Android evidence diagnostics boundary", () => {
  test("helper callbacks never serialize adversarial device output", () => {
    const chunks = [];
    const serial = "PHYSICAL_SERIAL_CANARY-R58N9911";
    const response = "MODEL_RESPONSE_CANARY-android-private";
    const boundary = createAndroidEvidenceBoundary({
      write: (chunk) => chunks.push(chunk),
    });

    boundary.callback("device-resolve")(
      `reusing attached device ${serial}; logcat=${response}`,
    );
    boundary.callback("route-capture")(
      `adb -s ${serial} stdout=${response} stderr=private`,
    );
    boundary.event("device-resolve", "passed", "DEVICE_READY");

    const output = chunks.join("");
    expect(output).toContain(
      "phase=device-resolve status=passed code=DEVICE_READY",
    );
    expect(output).not.toContain(serial);
    expect(output).not.toContain(response);
    expect(output).not.toMatch(/stdout|stderr|logcat/i);
    expect(() =>
      boundary.event("unknown-phase", "passed", "DEVICE_READY"),
    ).toThrow(/allowlisted/);
    expect(() =>
      boundary.event("runner", "passed", "PHASE_PASSED", {
        arbitraryCount: 1,
      }),
    ).toThrow(/counter name must be allowlisted/);
  });

  test("public bundle keeps allowlisted media and projects only safe phase codes", () => {
    const root = fixtureRoot();
    const privateRoot = path.join(root, "private");
    const outputDir = path.join(root, "public");
    const serial = "PHYSICAL_SERIAL_CANARY-R58N9922";
    fs.mkdirSync(path.join(privateRoot, "raw"), { recursive: true });
    fs.mkdirSync(path.join(privateRoot, "logs"), { recursive: true });
    const video = path.join(privateRoot, "raw", "android-route-coverage.mp4");
    const logcat = path.join(privateRoot, "logs", "android-logcat.txt");
    fs.writeFileSync(
      video,
      `synthetic-mp4-signal ${serial} MODEL_RESPONSE_CANARY`,
    );
    fs.writeFileSync(
      logcat,
      `${serial} roomId=room-private MODEL_RESPONSE_CANARY\n`,
    );
    const bundle = {
      root: privateRoot,
      lane: "android",
      build: { commit: "a".repeat(40), buildId: "b".repeat(64) },
      steps: [
        {
          name: "resolve Android device",
          status: "passed",
          durationMs: 12,
          artifacts: [],
        },
        {
          name: "Android route coverage",
          status: "failed",
          durationMs: 34,
          error: `${serial} stderr MODEL_RESPONSE_CANARY`,
          artifacts: [],
        },
      ],
      artifacts: [
        { kind: "video", path: video },
        { kind: "log", path: logcat },
      ],
      warnings: [`logcat from ${serial}`],
    };

    const result = projectAndroidDeviceEvidenceBundle({
      bundle,
      outputDir,
      result: "failed",
      redactVideo: (_source, destination) =>
        fs.writeFileSync(destination, "redacted-synthetic-mp4-signal"),
    });
    const files = fs.readdirSync(outputDir, { recursive: true });
    const serialized = files
      .filter((file) => /\.(?:json|xml|txt|log)$/i.test(file))
      .map((file) => fs.readFileSync(path.join(outputDir, file), "utf8"))
      .join("\n");

    expect(result.summary.device).toEqual({ kind: "android", attached: true });
    expect(result.summary.revision).toBe("a".repeat(40));
    expect(result.summary.rendererBuildId).toBe("b".repeat(64));
    expect(result.summary.counts).toMatchObject({
      passed: 1,
      failed: 1,
      mediaArtifacts: 1,
    });
    expect(files).toContain("media/android-route-coverage.mp4");
    expect(result.summary.media[0].sha256).toBe(
      createHash("sha256")
        .update("redacted-synthetic-mp4-signal")
        .digest("hex"),
    );
    expect(
      fs.readFileSync(
        path.join(outputDir, "media/android-route-coverage.mp4"),
        "utf8",
      ),
    ).not.toContain(serial);
    expect(files).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/logcat/i),
        expect.stringMatching(/runner\.log/i),
      ]),
    );
    expect(serialized).not.toContain(serial);
    expect(serialized).not.toContain("MODEL_RESPONSE_CANARY");
    expect(serialized).not.toMatch(
      /roomId|messageId|trajectoryId|stdout|stderr/i,
    );
    expect(() =>
      projectAndroidDeviceEvidenceBundle({
        bundle,
        outputDir,
        result: "failed",
        redactVideo: (_source, destination) =>
          fs.writeFileSync(destination, "redacted"),
      }),
    ).toThrow(/must not already exist/);
  });

  test("publishes beside an existing workflow bootstrap without replacing it", () => {
    const root = fixtureRoot();
    const privateRoot = path.join(root, "private-workflow-bundle");
    const androidArtifactRoot = path.join(root, "android");
    const logsDir = path.join(androidArtifactRoot, "logs");
    const bootstrap = path.join(logsDir, "workflow-bootstrap.txt");
    const outputDir = path.join(androidArtifactRoot, "evidence");
    fs.mkdirSync(privateRoot);
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(bootstrap, "revision=trusted-workflow-revision\n");

    projectAndroidDeviceEvidenceBundle({
      bundle: {
        root: privateRoot,
        lane: "android",
        build: { commit: "c".repeat(40), buildId: "d".repeat(64) },
        steps: [],
        artifacts: [],
      },
      outputDir,
      result: "failed",
    });

    expect(fs.readFileSync(bootstrap, "utf8")).toBe(
      "revision=trusted-workflow-revision\n",
    );
    expect(fs.readdirSync(androidArtifactRoot).sort()).toEqual([
      "evidence",
      "logs",
    ]);
    expect(fs.readdirSync(outputDir).sort()).toEqual([
      "junit.xml",
      "media",
      "summary.json",
    ]);
  });

  test("fails closed before export when build identifiers are absent or malformed", () => {
    const root = fixtureRoot();
    const privateRoot = path.join(root, "private-build-identity");
    const outputDir = path.join(root, "public-build-identity");
    fs.mkdirSync(privateRoot);
    const baseBundle = {
      root: privateRoot,
      lane: "android",
      steps: [],
      artifacts: [],
    };

    expect(() =>
      projectAndroidDeviceEvidenceBundle({
        bundle: {
          ...baseBundle,
          build: {
            commit: "PHYSICAL_SERIAL_CANARY-not-a-revision",
            buildId: "b".repeat(64),
          },
        },
        outputDir,
        result: "failed",
      }),
    ).toThrow(/revision/);
    expect(fs.existsSync(outputDir)).toBe(false);

    expect(() =>
      projectAndroidDeviceEvidenceBundle({
        bundle: {
          ...baseBundle,
          build: {
            commit: "a".repeat(40),
            buildId: "MODEL_RESPONSE_CANARY-not-a-renderer-build",
          },
        },
        outputDir,
        result: "failed",
      }),
    ).toThrow(/renderer build ID/);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "rejects a symlink destination without writing through it",
    () => {
      const root = fixtureRoot();
      const privateRoot = path.join(root, "private-symlink-output");
      const outputDir = path.join(root, "public-symlink-output");
      const externalTarget = path.join(root, "external-target");
      fs.mkdirSync(privateRoot);
      fs.mkdirSync(externalTarget);
      fs.symlinkSync(externalTarget, outputDir, "dir");

      expect(() =>
        projectAndroidDeviceEvidenceBundle({
          bundle: {
            root: privateRoot,
            lane: "android",
            build: { commit: "1".repeat(40), buildId: "2".repeat(64) },
            steps: [],
            artifacts: [],
          },
          outputDir,
          result: "failed",
        }),
      ).toThrow(/cannot be a symlink/);
      expect(fs.readdirSync(externalTarget)).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a symlink output parent without creating external entries",
    () => {
      const root = fixtureRoot();
      const privateRoot = path.join(root, "private-symlink-parent");
      const externalTarget = path.join(root, "external-parent-target");
      const outputParent = path.join(root, "public-parent-alias");
      const outputDir = path.join(outputParent, "public");
      fs.mkdirSync(privateRoot);
      fs.mkdirSync(externalTarget);
      fs.symlinkSync(externalTarget, outputParent, "dir");

      expect(() =>
        projectAndroidDeviceEvidenceBundle({
          bundle: {
            root: privateRoot,
            lane: "android",
            build: { commit: "b".repeat(40), buildId: "c".repeat(64) },
            steps: [],
            artifacts: [],
          },
          outputDir,
          result: "failed",
        }),
      ).toThrow(/output parent must be a real directory/);
      expect(fs.readdirSync(externalTarget)).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects destination substitution and removes the verified staging tree",
    () => {
      const root = fixtureRoot();
      const privateRoot = path.join(root, "private-destination-race");
      const rawDir = path.join(privateRoot, "raw");
      const source = path.join(rawDir, "android-route-coverage.mp4");
      const outputDir = path.join(root, "public-destination-race");
      const externalTarget = path.join(root, "external-race-target");
      fs.mkdirSync(rawDir, { recursive: true });
      fs.mkdirSync(externalTarget);
      fs.writeFileSync(source, "private-route-video");
      let stagingRoot;

      expect(() =>
        projectAndroidDeviceEvidenceBundle({
          bundle: {
            root: privateRoot,
            lane: "android",
            build: { commit: "3".repeat(40), buildId: "4".repeat(64) },
            steps: [{ name: "Android route coverage", status: "passed" }],
            artifacts: [{ kind: "video", path: source }],
          },
          outputDir,
          result: "passed",
          redactVideo: (_source, destination) => {
            stagingRoot = path.dirname(path.dirname(destination));
            fs.writeFileSync(destination, "projected-route-video");
            fs.symlinkSync(externalTarget, outputDir, "dir");
          },
        }),
      ).toThrow(/appeared before atomic publication/);
      expect(fs.readdirSync(externalTarget)).toEqual([]);
      expect(fs.existsSync(stagingRoot)).toBe(false);
      expect(
        fs
          .readdirSync(root)
          .some((entry) => entry.includes("android-evidence-staging")),
      ).toBe(false);
    },
  );

  test("projection failure leaves no public or partial staging directory", () => {
    const root = fixtureRoot();
    const privateRoot = path.join(root, "private-projection-failure");
    const rawDir = path.join(privateRoot, "raw");
    const source = path.join(rawDir, "android-route-coverage.mp4");
    const outputDir = path.join(root, "public-projection-failure");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(source, "private-route-video");

    expect(() =>
      projectAndroidDeviceEvidenceBundle({
        bundle: {
          root: privateRoot,
          lane: "android",
          build: { commit: "5".repeat(40), buildId: "6".repeat(64) },
          steps: [{ name: "Android route coverage", status: "passed" }],
          artifacts: [{ kind: "video", path: source }],
        },
        outputDir,
        result: "passed",
        redactVideo: (_source, destination) => {
          fs.writeFileSync(destination, "partial-projected-route-video");
          throw new Error("injected projection failure");
        },
      }),
    ).toThrow(/injected projection failure/);
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(
      fs
        .readdirSync(root)
        .some((entry) => entry.includes("android-evidence-staging")),
    ).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "rejects publication ancestry writable by another principal",
    () => {
      const root = fixtureRoot();
      const privateRoot = path.join(root, "private-untrusted-parent");
      const unsafeParent = path.join(root, "unsafe-parent");
      const outputDir = path.join(unsafeParent, "public");
      fs.mkdirSync(privateRoot);
      fs.mkdirSync(unsafeParent, { mode: 0o700 });
      fs.chmodSync(unsafeParent, 0o777);
      try {
        expect(() =>
          projectAndroidDeviceEvidenceBundle({
            bundle: {
              root: privateRoot,
              lane: "android",
              build: { commit: "7".repeat(40), buildId: "8".repeat(64) },
              steps: [],
              artifacts: [],
            },
            outputDir,
            result: "failed",
          }),
        ).toThrow(/writable by another principal/);
        expect(fs.existsSync(outputDir)).toBe(false);
      } finally {
        fs.chmodSync(unsafeParent, 0o700);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "detects publication parent identity substitution",
    () => {
      const root = fixtureRoot();
      const privateRoot = path.join(root, "private-parent-race");
      const rawDir = path.join(privateRoot, "raw");
      const source = path.join(rawDir, "android-route-coverage.mp4");
      const publicationParent = path.join(root, "publication-parent");
      const displacedParent = path.join(root, "publication-parent-displaced");
      const outputDir = path.join(publicationParent, "public");
      fs.mkdirSync(rawDir, { recursive: true });
      fs.mkdirSync(publicationParent, { mode: 0o700 });
      fs.writeFileSync(source, "private-route-video");

      expect(() =>
        projectAndroidDeviceEvidenceBundle({
          bundle: {
            root: privateRoot,
            lane: "android",
            build: { commit: "9".repeat(40), buildId: "a".repeat(64) },
            steps: [{ name: "Android route coverage", status: "passed" }],
            artifacts: [{ kind: "video", path: source }],
          },
          outputDir,
          result: "passed",
          redactVideo: (_source, destination) => {
            fs.writeFileSync(destination, "projected-route-video");
            fs.renameSync(publicationParent, displacedParent);
            fs.mkdirSync(publicationParent, { mode: 0o700 });
          },
        }),
      ).toThrow(/publication parent changed identity/);
      expect(fs.readdirSync(publicationParent)).toEqual([]);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(allPublicBytes(displacedParent)).not.toContain(
        "private-route-video",
      );
    },
  );

  test("requires one redacted video only when route capture passed", () => {
    const root = fixtureRoot();
    const privateRoot = path.join(root, "private-route-proof");
    const missingOutput = path.join(root, "public-missing-route-proof");
    const canonicalOutput = path.join(root, "public-canonical-route-proof");
    const skippedOutput = path.join(root, "public-skipped-route-proof");
    const rawDir = path.join(privateRoot, "raw");
    const inlineDir = path.join(privateRoot, "inline");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(inlineDir, { recursive: true });
    const identity = {
      commit: "e".repeat(40),
      buildId: "f".repeat(64),
    };

    expect(() =>
      projectAndroidDeviceEvidenceBundle({
        bundle: {
          root: privateRoot,
          lane: "android",
          build: identity,
          steps: [{ name: "Android route coverage", status: "passed" }],
          artifacts: [],
        },
        outputDir: missingOutput,
        result: "passed",
      }),
    ).toThrow(/exactly one private video/);
    expect(fs.existsSync(missingOutput)).toBe(false);

    const canonicalVideo = path.join(rawDir, "android-route-coverage.mp4");
    const inlineDuplicate = path.join(inlineDir, "android-route-coverage.mp4");
    fs.writeFileSync(canonicalVideo, "canonical-private-video");
    fs.writeFileSync(
      inlineDuplicate,
      "PHYSICAL_SERIAL_CANARY-inline-duplicate",
    );
    let projectedSource = null;
    const canonical = projectAndroidDeviceEvidenceBundle({
      bundle: {
        root: privateRoot,
        lane: "android",
        build: identity,
        steps: [{ name: "Android route coverage", status: "passed" }],
        artifacts: [
          { kind: "video", path: canonicalVideo },
          { kind: "video", path: inlineDuplicate },
        ],
      },
      outputDir: canonicalOutput,
      result: "passed",
      redactVideo: (source, destination) => {
        projectedSource = source;
        fs.writeFileSync(destination, "redacted-canonical-video");
      },
    });
    expect(canonical.summary.counts.mediaArtifacts).toBe(1);
    expect(projectedSource).toBe(canonicalVideo);
    expect(allPublicBytes(canonicalOutput)).not.toContain(
      "PHYSICAL_SERIAL_CANARY-inline-duplicate",
    );

    const skipped = projectAndroidDeviceEvidenceBundle({
      bundle: {
        root: privateRoot,
        lane: "android",
        build: identity,
        steps: [{ name: "local chat smoke", status: "passed" }],
        artifacts: [],
      },
      outputDir: skippedOutput,
      result: "passed",
    });
    expect(skipped.summary.counts.mediaArtifacts).toBe(0);
    expect(skipped.summary.phases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "route-capture" }),
      ]),
    );
  });

  test("teardown failures cannot bypass lease release, projection, or private cleanup", async () => {
    const root = fixtureRoot();
    const privateRoot = path.join(root, "private-teardown-canary");
    fs.mkdirSync(privateRoot);
    fs.writeFileSync(
      path.join(privateRoot, "raw.log"),
      "PHYSICAL_SERIAL_CANARY teardown MODEL_RESPONSE_CANARY",
    );
    const calls = [];

    const result = await settleAndroidEvidenceTeardown({
      operations: [
        {
          phase: "route-capture",
          run: async () => {
            calls.push("stop");
            throw new Error("PHYSICAL_SERIAL_CANARY stop failed");
          },
        },
        {
          phase: "device-lease",
          run: () => calls.push("release"),
        },
      ],
      project: ({ failureCount }) => {
        calls.push(`project-${failureCount}`);
        throw new Error("MODEL_RESPONSE_CANARY projection failed");
      },
      cleanup: () => {
        calls.push("cleanup");
        fs.rmSync(privateRoot, { recursive: true, force: true });
      },
      onFailure: (phase) => calls.push(`failed-${phase}`),
    });

    expect(result).toEqual({ failureCount: 2 });
    expect(calls).toEqual([
      "stop",
      "failed-route-capture",
      "release",
      "project-1",
      "failed-evidence-projection",
      "cleanup",
    ]);
    expect(fs.existsSync(privateRoot)).toBe(false);
  });

  test.skipIf(!ffmpegAvailable)(
    "default video projector removes source metadata and trailing-byte canaries",
    () => {
      const root = fixtureRoot();
      const privateRoot = path.join(root, "private-real-media");
      const outputDir = path.join(root, "public-real-media");
      const rawDir = path.join(privateRoot, "raw");
      const source = path.join(rawDir, "android-route-coverage.mp4");
      const canary = "PHYSICAL_SERIAL_CANARY-METADATA-R58N9944";
      fs.mkdirSync(rawDir, { recursive: true });
      const generated = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=64x64:d=1",
          "-metadata",
          `comment=${canary}`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          source,
        ],
        { stdio: "ignore" },
      );
      expect(generated.status).toBe(0);
      fs.appendFileSync(source, `\n${canary}\n`);

      projectAndroidDeviceEvidenceBundle({
        bundle: {
          root: privateRoot,
          lane: "android",
          build: { commit: "c".repeat(40), buildId: "d".repeat(64) },
          steps: [{ name: "Android route coverage", status: "passed" }],
          artifacts: [{ kind: "video", path: source }],
        },
        outputDir,
        result: "passed",
      });

      const publicBytes = fs
        .readdirSync(outputDir, { recursive: true })
        .filter((entry) => fs.statSync(path.join(outputDir, entry)).isFile())
        .map((entry) => fs.readFileSync(path.join(outputDir, entry)));
      expect(Buffer.concat(publicBytes).includes(canary)).toBe(false);
    },
  );
});
