/**
 * Unit tests for desktop bug report diagnostics formatting.
 */
import { describe, expect, it } from "vitest";
import {
  type DesktopBugReportDiagnostics,
  formatDesktopBugReportDiagnostics,
  loadDesktopBugReportDiagnostics,
} from "../desktop-bug-report.ts";

describe("desktop-bug-report", () => {
  describe("formatDesktopBugReportDiagnostics", () => {
    it("formats complete diagnostics record into readable multiline text", () => {
      const diagnostics: DesktopBugReportDiagnostics = {
        state: "running",
        phase: "ready",
        updatedAt: "2026-08-24T00:00:00Z",
        lastError: null,
        agentName: "Eliza",
        port: 3000,
        startedAt: 1700000000000,
        platform: "darwin",
        arch: "arm64",
        configDir: "/Users/user/.eliza",
        logPath: "/Users/user/.eliza/logs/agent.log",
        statusPath: "/Users/user/.eliza/status.json",
        logTail: "All systems go",
        appVersion: "1.0.0",
        appRuntime: "electrobun",
        packaged: true,
        locale: "en-US",
      };

      const formatted = formatDesktopBugReportDiagnostics(diagnostics);
      expect(formatted).toContain("App Version: 1.0.0");
      expect(formatted).toContain("Runtime: electrobun");
      expect(formatted).toContain("Packaged: yes");
      expect(formatted).toContain("Platform: darwin arm64");
      expect(formatted).toContain("Locale: en-US");
      expect(formatted).toContain("Startup State: running");
      expect(formatted).toContain("Startup Phase: ready");
      expect(formatted).toContain("Last Error: none");
      expect(formatted).toContain("Agent Name: Eliza");
      expect(formatted).toContain("Port: 3000");
    });

    it("handles missing optional diagnostics fields gracefully", () => {
      const minimal: DesktopBugReportDiagnostics = {
        state: "error",
        phase: "failed",
        updatedAt: "2026-08-24T00:00:00Z",
        lastError: "Port already in use",
        agentName: null,
        port: null,
        startedAt: null,
        platform: "linux",
        arch: "x64",
        configDir: "/home/user/.eliza",
        logPath: "/home/user/.eliza/logs/agent.log",
        statusPath: "/home/user/.eliza/status.json",
        logTail: "Fatal error",
      };

      const formatted = formatDesktopBugReportDiagnostics(minimal);
      expect(formatted).toContain("App Version: unknown");
      expect(formatted).toContain("Packaged: unknown");
      expect(formatted).toContain("Agent Name: unknown");
      expect(formatted).toContain("Port: unknown");
      expect(formatted).toContain("Last Error: Port already in use");
    });
  });

  describe("loadDesktopBugReportDiagnostics", () => {
    it("returns null when running outside electrobun runtime", async () => {
      const result = await loadDesktopBugReportDiagnostics();
      expect(result).toBeNull();
    });
  });
});
