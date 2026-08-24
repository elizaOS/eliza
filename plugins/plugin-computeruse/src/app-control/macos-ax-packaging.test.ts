/** Verifies the native AX helper is packaged and preserves no-prompt/no-pointer safety seams. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("macOS AX helper packaging", () => {
  it("compiles the helper into the published dist/native tree", () => {
    const build = readFileSync(`${packageRoot}/build.ts`, "utf8");
    const manifest = JSON.parse(
      readFileSync(`${packageRoot}/package.json`, "utf8"),
    ) as { files: string[] };
    expect(build).toContain('"xcrun"');
    expect(build).toContain('"swiftc"');
    expect(build).toContain('path.resolve("dist/native")');
    expect(build).toContain('"macos-ax-helper"');
    expect(manifest.files).toContain("dist");
    const adapter = readFileSync(
      `${packageRoot}/src/app-control/macos-ax-adapter.ts`,
      "utf8",
    );
    expect(adapter).toContain(
      'new URL("./native/macos-ax-helper", import.meta.url)',
    );
  });

  it("checks trust without prompting and posts app-scoped key events", () => {
    const source = readFileSync(
      `${packageRoot}/native/macos-ax-helper.swift`,
      "utf8",
    );
    expect(source).toContain("AXIsProcessTrusted()");
    expect(source).not.toContain("AXIsProcessTrustedWithOptions");
    expect(source).toContain("postToPid(pid)");
    expect(source).not.toContain("CGEventPost(.cghidEventTap");
    expect(source).not.toContain(".post(tap:");
    expect(source).not.toContain("mouseEventSource:");
    expect(source).not.toContain("scrollWheelEvent2Source:");
    expect(source).toContain("CGWindowListCopyWindowInfo");
    expect(source).toContain('expected["windowId"]');
    expect(source).toContain('result["focusedWindowId"]');
    expect(source).toContain('"targetWindowId": Int(currentWindowId)');
    expect(source).toContain("eligibleWindowCount == 1");
    expect(source).toContain("if candidates.count == 1");
    expect(source).toContain("if titleMatches.count == 1");
    expect(source).toContain(
      "Process-scoped keyboard event refused because the PID has multiple eligible windows",
    );
    expect(source).toContain("snapshotPasteboard");
    expect(source).toContain("restorePasteboard");
    expect(source).toContain("AXUIElementPerformAction");
    expect(source).toContain("AXUIElementSetAttributeValue");
    expect(source).toContain("redactSensitive");
    expect(source).toContain("[redacted]");
  });

  it("keeps global physical input behind opt-in and a distinct approval", () => {
    const defaults = readFileSync(
      `${packageRoot}/src/app-control/defaults.ts`,
      "utf8",
    );
    const service = readFileSync(
      `${packageRoot}/src/services/computer-use-service.ts`,
      "utf8",
    );
    expect(defaults).toContain(
      'OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS === "1"',
    );
    expect(service).toContain(
      'process.env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS !== "1"',
    );
    expect(service).toContain('"app_physical_pointer_fallback"');
    expect(service).toContain("requestApproval(");
  });
});
