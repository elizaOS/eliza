/**
 * Unit tests for desktop bug report diagnostics formatting and bridge helpers.
 * Validates diagnostic report string formatting, fallback values, and non-desktop runtime guards.
 */
import { describe, expect, it } from "vitest";
import {
  createDesktopBugReportBundle,
  type DesktopBugReportDiagnostics,
  formatDesktopBugReportDiagnostics,
  loadDesktopBugReportDiagnostics,
  openDesktopLogsFolder,
} from "../desktop-bug-report.ts";

describe("desktop-bug-report", () => {
  describe("formatDesktopBugReportDiagnostics", () => {
    it("formats complete diagnostics record into human-readable multi-line report", () => {
      const diag: DesktopBugReportDiagnostics = {
        appVersion: "2.0.0",
        appRuntime: "electrobun-1.0.0",
        packaged: true,
        platform: "darwin",
        arch: "arm64",
        locale: "en-US",
        state: "running",
        phase: "ready",
        lastError: null,
        agentName: "Eliza Agent",
        port: 3000,
        startedAt: 1700000000000,
        configDir: "/home/user/.eliza",
        logPath: "/home/user/.eliza/logs/out.log",
        statusPath: "/home/user/.eliza/status.json",
        logTail: "server started",
        updatedAt: "2026-08-24T00:00:00Z",
      };

      const output = formatDesktopBugReportDiagnostics(diag);

      expect(output).toContain("App Version: 2.0.0");
      expect(output).toContain("Runtime: electrobun-1.0.0");
      expect(output).toContain("Packaged: yes");
      expect(output).toContain("Platform: darwin arm64");
      expect(output).toContain("Locale: en-US");
      expect(output).toContain("Startup State: running");
      expect(output).toContain("Startup Phase: ready");
      expect(output).toContain("Last Error: none");
      expect(output).toContain("Agent Name: Eliza Agent");
      expect(output).toContain("Port: 3000");
      expect(output).toContain("Log Path: /home/user/.eliza/logs/out.log");
    });

    it("formats default fallbacks for missing optional properties", () => {
      const diag: DesktopBugReportDiagnostics = {
        state: "error",
        phase: "init",
        lastError: "Database lock timeout",
        agentName: null,
        port: null,
        startedAt: null,
        platform: "linux",
        arch: "x64",
        configDir: "/etc/eliza",
        logPath: "/var/log/eliza.log",
        statusPath: "/var/run/eliza.json",
        logTail: "crash dump",
        updatedAt: "2026-08-24T01:00:00Z",
      };

      const output = formatDesktopBugReportDiagnostics(diag);

      expect(output).toContain("App Version: unknown");
      expect(output).toContain("Runtime: unknown");
      expect(output).toContain("Packaged: unknown");
      expect(output).toContain("Locale: unknown");
      expect(output).toContain("Last Error: Database lock timeout");
      expect(output).toContain("Agent Name: unknown");
      expect(output).toContain("Port: unknown");
    });
  });

  describe("desktop bridge invocation guards", () => {
    it("returns null or no-op when not in Electrobun runtime", async () => {
      expect(await loadDesktopBugReportDiagnostics()).toBeNull();
      expect(
        await createDesktopBugReportBundle({
          reportMarkdown: "# Report",
          reportJson: {},
        }),
      ).toBeNull();
      await expect(openDesktopLogsFolder()).resolves.toBeUndefined();
    });
  });
});
