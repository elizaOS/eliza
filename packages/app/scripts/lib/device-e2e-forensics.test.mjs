/**
 * Drives the real forensics step-executor against a temp bundle dir with fake
 * capture callbacks (write-file / return-null / throw) — no device. Asserts the
 * failure dir shape, the summary-step schema, that the original error always
 * propagates, and that a passing run leaves no `failure/` dir.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureForensics,
  formatFailureBlock,
  runStep,
  slugifyStep,
} from "./device-e2e-forensics.mjs";

let bundleDir;

beforeEach(() => {
  bundleDir = mkdtempSync(path.join(tmpdir(), "forensics-test-"));
});

afterEach(() => {
  // Temp dirs are per-test; leaving them is harmless on CI runners that wipe
  // tmp, and removing recursively here would race a slow capture. No-op.
});

const writingCapture = (contents) => (outPath) => {
  writeFileSync(outPath, contents);
  return outPath;
};

describe("slugifyStep", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyStep("Boot iOS Simulator")).toBe("boot-ios-simulator");
  });
  it("falls back to 'step' for punctuation-only names", () => {
    expect(slugifyStep("***")).toBe("step");
  });
});

describe("runStep — passing", () => {
  it("records a passed step and returns the value, no failure dir", async () => {
    const ledger = [];
    const value = await runStep(
      {
        name: "install app",
        bundleDir,
        fn: async () => "installed",
        captureScreenshot: writingCapture("shot"),
        captureDeviceLog: writingCapture("log"),
      },
      ledger,
    );
    expect(value).toBe("installed");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      name: "install app",
      status: "passed",
      artifacts: [],
    });
    expect(typeof ledger[0].durationMs).toBe("number");
    expect(existsSync(path.join(bundleDir, "failure"))).toBe(false);
  });
});

describe("runStep — failing", () => {
  it("captures forensics, records failed step, and rethrows original error", async () => {
    const ledger = [];
    const original = new Error("adb: device offline");
    await expect(
      runStep(
        {
          name: "route coverage",
          bundleDir,
          fn: async () => {
            throw original;
          },
          captureScreenshot: writingCapture("PNGDATA"),
          captureDeviceLog: writingCapture("logcat tail"),
        },
        ledger,
      ),
    ).rejects.toBe(original);

    const failureDir = path.join(bundleDir, "failure", "route-coverage");
    expect(readFileSync(path.join(failureDir, "screenshot.png"), "utf8")).toBe(
      "PNGDATA",
    );
    expect(readFileSync(path.join(failureDir, "device-log.txt"), "utf8")).toBe(
      "logcat tail",
    );

    expect(ledger).toHaveLength(1);
    const step = ledger[0];
    expect(step.status).toBe("failed");
    expect(step.error).toBe("adb: device offline");
    expect(step.artifacts).toEqual([
      { kind: "screenshot", path: path.join(failureDir, "screenshot.png") },
      { kind: "device-log", path: path.join(failureDir, "device-log.txt") },
    ]);
    expect(step.forensicsWarnings).toBeUndefined();
  });

  it("awaits async capture callbacks before recording artifacts", async () => {
    const ledger = [];
    await expect(
      runStep(
        {
          name: "async capture",
          bundleDir,
          fn: async () => {
            throw new Error("step failed");
          },
          captureScreenshot: async (outPath) => {
            await Promise.resolve();
            writeFileSync(outPath, "async shot");
            return outPath;
          },
          captureDeviceLog: async (outPath) => {
            await Promise.resolve();
            writeFileSync(outPath, "async log");
            return outPath;
          },
        },
        ledger,
      ),
    ).rejects.toThrow("step failed");

    const failureDir = path.join(bundleDir, "failure", "async-capture");
    expect(readFileSync(path.join(failureDir, "screenshot.png"), "utf8")).toBe(
      "async shot",
    );
    expect(readFileSync(path.join(failureDir, "device-log.txt"), "utf8")).toBe(
      "async log",
    );
    expect(ledger[0].artifacts).toEqual([
      { kind: "screenshot", path: path.join(failureDir, "screenshot.png") },
      { kind: "device-log", path: path.join(failureDir, "device-log.txt") },
    ]);
  });

  it("a capture that throws becomes a warning, never masks the step error", async () => {
    const ledger = [];
    const original = new Error("smoke failed");
    await expect(
      runStep(
        {
          name: "local chat smoke",
          bundleDir,
          fn: async () => {
            throw original;
          },
          captureScreenshot: () => {
            throw new Error("device disconnected");
          },
          captureDeviceLog: writingCapture("partial log"),
        },
        ledger,
      ),
    ).rejects.toBe(original);

    const step = ledger[0];
    expect(step.status).toBe("failed");
    expect(step.error).toBe("smoke failed");
    // screenshot threw → only device-log artifact survives
    expect(step.artifacts).toEqual([
      {
        kind: "device-log",
        path: path.join(
          bundleDir,
          "failure",
          "local-chat-smoke",
          "device-log.txt",
        ),
      },
    ]);
    expect(step.forensicsWarnings).toEqual([
      "screenshot capture failed: device disconnected",
    ]);
  });

  it("a capture returning null is warned, not recorded as an artifact", async () => {
    const ledger = [];
    await expect(
      runStep(
        {
          name: "boot",
          bundleDir,
          fn: async () => {
            throw new Error("boot timeout");
          },
          captureScreenshot: () => null,
          captureDeviceLog: () => null,
        },
        ledger,
      ),
    ).rejects.toThrow("boot timeout");
    const step = ledger[0];
    expect(step.artifacts).toEqual([]);
    expect(step.forensicsWarnings).toEqual([
      "screenshot capture produced no file",
      "device-log capture produced no file",
    ]);
  });

  it("omits captures the platform did not wire (undefined callbacks)", async () => {
    const ledger = [];
    await expect(
      runStep(
        {
          name: "auth",
          bundleDir,
          fn: async () => {
            throw new Error("auth 500");
          },
        },
        ledger,
      ),
    ).rejects.toThrow("auth 500");
    expect(ledger[0].artifacts).toEqual([]);
    expect(ledger[0].forensicsWarnings).toBeUndefined();
  });
});

describe("captureForensics", () => {
  it("returns a warning when the failure dir cannot be created", async () => {
    // Point failureDir at a path whose parent is a file → mkdir must fail.
    const filePath = path.join(bundleDir, "not-a-dir");
    writeFileSync(filePath, "x");
    const { artifacts, warnings } = await captureForensics({
      failureDir: path.join(filePath, "failure", "step"),
      captureScreenshot: writingCapture("x"),
      captureDeviceLog: writingCapture("x"),
    });
    expect(artifacts).toEqual([]);
    expect(warnings[0]).toMatch(/failure dir unwritable/);
  });

  it("warns instead of recording a returned path that was not written", async () => {
    const missing = path.join(bundleDir, "missing.png");
    const { artifacts, warnings } = await captureForensics({
      failureDir: path.join(bundleDir, "failure", "missing-output"),
      captureScreenshot: () => missing,
      captureDeviceLog: null,
    });
    expect(artifacts).toEqual([]);
    expect(warnings).toEqual([
      `screenshot capture returned missing file: ${missing}`,
    ]);
  });
});

describe("formatFailureBlock", () => {
  it("returns null when no step failed", () => {
    const ledger = [{ name: "a", status: "passed", artifacts: [] }];
    expect(formatFailureBlock(ledger)).toBeNull();
  });

  it("names the failing step, cause, and absolute artifact paths", () => {
    const ledger = [
      { name: "build", status: "passed", artifacts: [] },
      {
        name: "smoke",
        status: "failed",
        error: "assertion failed",
        artifacts: [
          { kind: "screenshot", path: "failure/smoke/screenshot.png" },
        ],
      },
    ];
    const block = formatFailureBlock(ledger, { bundleDir: "/tmp/bundle" });
    expect(block).toContain("step:  smoke");
    expect(block).toContain("cause: assertion failed");
    expect(block).toContain("/tmp/bundle/failure/smoke/screenshot.png");
  });

  it("reports (none captured) and surfaces forensics warnings", () => {
    const ledger = [
      {
        name: "boot",
        status: "failed",
        error: "timeout",
        artifacts: [],
        forensicsWarnings: ["screenshot capture failed: device gone"],
      },
    ];
    const block = formatFailureBlock(ledger);
    expect(block).toContain("artifacts: (none captured)");
    expect(block).toContain("! screenshot capture failed: device gone");
  });
});
