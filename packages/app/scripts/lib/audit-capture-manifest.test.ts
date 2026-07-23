/**
 * Proves the audit manifest is report-scoped and rejects ambiguous evidence.
 */
import { describe, expect, it } from "vitest";
import {
  buildAuditCaptureManifest,
  parseAuditReport,
  validateOcrRecordPaths,
} from "./audit-capture-manifest";

const report = [
  { slug: "builtin-chat", viewport: "mobile-portrait" },
  { slug: "plugin-wallet-gui", viewport: "desktop-landscape" },
];

describe("buildAuditCaptureManifest", () => {
  it("selects only screenshots named by the current report", () => {
    expect(buildAuditCaptureManifest("/audit", report)).toEqual([
      {
        key: "builtin-chat::mobile-portrait",
        path: "/audit/mobile-portrait/builtin-chat.png",
        slug: "builtin-chat",
        viewport: "mobile-portrait",
      },
      {
        key: "plugin-wallet-gui::desktop-landscape",
        path: "/audit/desktop-landscape/plugin-wallet-gui.png",
        slug: "plugin-wallet-gui",
        viewport: "desktop-landscape",
      },
    ]);
  });

  it("rejects duplicate report rows", () => {
    expect(() =>
      buildAuditCaptureManifest("/audit", [report[0], report[0]]),
    ).toThrow("Duplicate audit report row");
  });
});

describe("parseAuditReport", () => {
  it("rejects malformed report boundaries", () => {
    expect(() => parseAuditReport({})).toThrow("must be an array");
    expect(() =>
      parseAuditReport([{ slug: "../old", viewport: "mobile" }]),
    ).toThrow("Invalid audit slug");
  });
});

describe("validateOcrRecordPaths", () => {
  const manifest = buildAuditCaptureManifest("/audit", report);

  it("rejects a stale extra screenshot", () => {
    expect(() =>
      validateOcrRecordPaths(
        [
          { path: manifest[0].path },
          { path: manifest[1].path },
          { path: "/audit/mobile-portrait/retired-social-alpha.png" },
        ],
        manifest,
      ),
    ).toThrow("not in the current audit report");
    expect(() =>
      validateOcrRecordPaths(
        [
          { path: "/old/mobile-portrait/builtin-chat.png" },
          { path: manifest[1].path },
        ],
        manifest,
      ),
    ).toThrow("not in the current audit report");
  });

  it("rejects missing and duplicate OCR rows", () => {
    expect(() =>
      validateOcrRecordPaths([{ path: manifest[0].path }], manifest),
    ).toThrow("missing current audit rows");
    expect(() =>
      validateOcrRecordPaths(
        [
          { path: manifest[0].path },
          { path: manifest[0].path },
          { path: manifest[1].path },
        ],
        manifest,
      ),
    ).toThrow("Duplicate OCR input");
  });

  it("accepts paths relative to the audit directory", () => {
    expect(() =>
      validateOcrRecordPaths(
        [
          { path: "mobile-portrait/builtin-chat.png" },
          { path: "desktop-landscape/plugin-wallet-gui.png" },
        ],
        manifest,
        "/audit",
      ),
    ).not.toThrow();
  });
});
