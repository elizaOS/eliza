/**
 * Unit tests for the issue #15744 LP3 evidence harness helpers.
 *
 * These tests cover pure parsing, safety gates, manifest hashing, and report
 * validation without requiring adb, an APK, or a physical Light Phone.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeAdbInvocation,
  assertSafeCommandInvocation,
  buildManifest,
  filterLogcat,
  HarnessError,
  parseCliArgs,
  processMatchesSession,
  sanitizeToken,
  sha256File,
  validateReport,
} from "./pendant-lightphone-e2e.mjs";

function tempDir() {
  return path.join(
    os.tmpdir(),
    `pendant-lightphone-e2e-${Date.now()}-${Math.random()}`,
  );
}

describe("parseCliArgs", () => {
  it("parses subcommands, values, booleans, equals syntax, and repeated flags", () => {
    const parsed = parseCliArgs([
      "capture",
      "--serial",
      "LP3",
      "--apk=/tmp/app.apk",
      "--clean-install",
      "--selector",
      "[data-testid=a]",
      "--selector",
      "[data-testid=b]",
    ]);
    expect(parsed.subcommand).toBe("capture");
    expect(parsed.flags.serial).toBe("LP3");
    expect(parsed.flags.apk).toBe("/tmp/app.apk");
    expect(parsed.flags["clean-install"]).toBe(true);
    expect(parsed.flags.selector).toEqual([
      "[data-testid=a]",
      "[data-testid=b]",
    ]);
  });
});

describe("adb safety gate", () => {
  it("rejects destructive or privileged shell commands", () => {
    expect(() =>
      assertSafeAdbInvocation([
        "-s",
        "LP3",
        "shell",
        "pm",
        "clear",
        "ai.elizaos.app",
      ]),
    ).toThrow(HarnessError);
    expect(() =>
      assertSafeAdbInvocation(["-s", "LP3", "shell", "reboot"]),
    ).toThrow(HarnessError);
    expect(() =>
      assertSafeAdbInvocation(["-s", "LP3", "shell", "su", "-c", "id"]),
    ).toThrow(HarnessError);
    expect(() =>
      assertSafeAdbInvocation(["-s", "LP3", "shell", "PM", "Grant", "x", "y"]),
    ).toThrow(HarnessError);
  });

  it("rejects forbidden command tokens regardless of casing or path", () => {
    expect(() =>
      assertSafeCommandInvocation("/tmp/FastBoot", ["devices"]),
    ).toThrow(HarnessError);
    expect(() =>
      assertSafeCommandInvocation("adb", ["-s", "LP3", "Root"]),
    ).toThrow(HarnessError);
  });

  it("allows read-only inspection and app launch commands", () => {
    expect(() =>
      assertSafeAdbInvocation([
        "-s",
        "LP3",
        "shell",
        "dumpsys",
        "package",
        "ai.elizaos.app",
      ]),
    ).not.toThrow();
    expect(() =>
      assertSafeAdbInvocation([
        "-s",
        "LP3",
        "shell",
        "monkey",
        "-p",
        "ai.elizaos.app",
        "1",
      ]),
    ).not.toThrow();
  });
});

describe("process identity helpers", () => {
  it("matches only the expected pid/start time and command identity", () => {
    const current = {
      pid: 42,
      cmdline: ["/sdk/platform-tools/adb", "-s", "LP3", "logcat"],
      procStartTime: "123",
    };
    expect(
      processMatchesSession(current, {
        pid: 42,
        procStartTime: "123",
        contains: ["adb", "LP3", "logcat"],
      }),
    ).toBe(true);
    expect(
      processMatchesSession(current, {
        pid: 42,
        procStartTime: "124",
        contains: ["adb", "LP3", "logcat"],
      }),
    ).toBe(false);
    expect(
      processMatchesSession(current, {
        pid: 42,
        procStartTime: "123",
        contains: ["adb", "OTHER", "logcat"],
      }),
    ).toBe(false);
  });
});

describe("artifact helpers", () => {
  it("filters bounded logcat evidence to relevant lines", () => {
    const output = filterLogcat(
      "01 noise\n02 ai.elizaos.app useful\n03 BluetoothGatt useful\n04 unrelated\n",
    );
    expect(output).toContain("ai.elizaos.app");
    expect(output).toContain("BluetoothGatt");
    expect(output).not.toContain("unrelated");
  });

  it("builds a manifest with sha256 hashes", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    try {
      const artifact = path.join(dir, "artifact.txt");
      writeFileSync(artifact, "hello\n", "utf8");
      const manifest = buildManifest(dir);
      expect(manifest.files).toEqual([
        {
          path: "artifact.txt",
          size: 6,
          sha256: sha256File(artifact),
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes path tokens for session and remote names", () => {
    expect(sanitizeToken("LP3 serial/with spaces")).toBe(
      "LP3-serial-with-spaces",
    );
  });
});

describe("validateReport", () => {
  it("rejects physical pass checkpoints without artifacts", () => {
    const result = validateReport({
      checkpoints: [
        {
          id: "physical",
          proof: "physical",
          status: "pass",
          artifacts: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/physical pass requires artifacts/);
  });

  it("allows supplemental pass checkpoints to carry no physical artifacts", () => {
    const result = validateReport({
      checkpoints: [
        {
          id: "supplemental-emulation",
          proof: "supplemental",
          status: "pass",
          artifacts: [],
        },
      ],
    });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("rejects traversal artifacts", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    try {
      const result = validateReport(
        {
          checkpoints: [
            {
              id: "physical",
              proof: "physical",
              status: "pass",
              artifacts: [{ path: "../outside.txt", sha256: "a".repeat(64) }],
            },
          ],
        },
        dir,
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/escapes evidence root/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects prefix sibling bypass paths", () => {
    const parent = tempDir();
    const root = path.join(parent, "root");
    const sibling = path.join(parent, "root-sibling");
    mkdirSync(root, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const siblingFile = path.join(sibling, "artifact.txt");
    writeFileSync(siblingFile, "outside\n", "utf8");
    try {
      const result = validateReport(
        {
          checkpoints: [
            {
              id: "physical",
              proof: "physical",
              status: "pass",
              artifacts: [
                {
                  path: "../root-sibling/artifact.txt",
                  sha256: sha256File(siblingFile),
                },
              ],
            },
          ],
        },
        root,
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/escapes evidence root/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects physical pass artifacts without hashes", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "artifact.txt"), "hello\n", "utf8");
    try {
      const result = validateReport(
        {
          checkpoints: [
            {
              id: "physical",
              proof: "physical",
              status: "pass",
              artifacts: [{ path: "artifact.txt" }],
            },
          ],
        },
        dir,
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/requires sha256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate checkpoint IDs", () => {
    const result = validateReport({
      checkpoints: [
        {
          id: "same",
          proof: "supplemental",
          status: "unverified",
          artifacts: [],
        },
        {
          id: "same",
          proof: "supplemental",
          status: "unverified",
          artifacts: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/duplicate checkpoint id/);
  });

  it("rejects symlink escapes", () => {
    const parent = tempDir();
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside.txt");
    mkdirSync(root, { recursive: true });
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, path.join(root, "link.txt"));
    try {
      const result = validateReport(
        {
          checkpoints: [
            {
              id: "physical",
              proof: "physical",
              status: "pass",
              artifacts: [{ path: "link.txt", sha256: sha256File(outside) }],
            },
          ],
        },
        root,
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/symlink escapes/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
