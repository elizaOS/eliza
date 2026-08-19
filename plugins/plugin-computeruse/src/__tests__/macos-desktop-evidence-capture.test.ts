/**
 * Deterministic coverage for the macOS evidence classifier, loopback fixture,
 * and browser-cleanup failure precedence. Failure paths use an injected fixture
 * and command-service fake; the listener lifecycle test uses real loopback I/O.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupMacosBrowserEvidence,
  isMacosAccessibilityEvidenceBlocker,
  resolveMacosEvidenceGitHead,
  runBrowserCheck,
  startMacosBrowserEvidenceServer,
} from "../../scripts/capture-macos-desktop-evidence.mjs";

describe("macOS desktop evidence capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds evidence to the full immutable Git revision", () => {
    const fullSha = "a".repeat(40);
    const command = vi.fn(() => fullSha);

    expect(resolveMacosEvidenceGitHead(command)).toBe(fullSha);
    expect(command).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"]);
    expect(() => resolveMacosEvidenceGitHead(() => "abc1234")).toThrow(
      "requires a full Git commit SHA",
    );
  });

  it("classifies known Accessibility/TCC blockers as missing device evidence", () => {
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "list_windows returned only placeholder window metadata; grant Accessibility permission in System Settings > Privacy & Security > Accessibility, then retry",
      ),
    ).toBe(true);
    expect(
      isMacosAccessibilityEvidenceBlocker("spawnSync osascript ETIMEDOUT"),
    ).toBe(true);
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "could not read TextEdit bounds: Window not found; listWindows could not resolve the TextEdit window",
      ),
    ).toBe(true);
  });

  it("keeps unrelated capture failures as hard failures", () => {
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "browser_screenshot failed: target closed unexpectedly",
      ),
    ).toBe(false);
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "primary display screenshot: screenshot quality failed",
      ),
    ).toBe(false);
  });

  it("serves the browser fixture only on ephemeral loopback and closes it", async () => {
    const fixture = await startMacosBrowserEvidenceServer();
    expect(fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const response = await fetch(fixture.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("macOS CUA Evidence");

    await fixture.close();
    await expect(
      fetch(fixture.url, { signal: AbortSignal.timeout(1_000) }),
    ).rejects.toThrow();
  });

  it("always closes the fixture when browser_close rejects and preserves the primary failure", async () => {
    const cleanupWarning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const fixtureClose = vi.fn(async () => {});
    const service = {
      async executeCommand(command: string, params?: { url?: string }) {
        if (command === "browser_open") {
          return { success: true, url: params?.url };
        }
        if (command === "browser_get_dom") {
          return { success: false, error: "primary DOM failure" };
        }
        if (command === "browser_close") {
          throw new Error("browser shutdown rejected");
        }
        throw new Error(`unexpected command: ${command}`);
      },
    };

    await expect(
      runBrowserCheck(service, "/unused", [], async () => ({
        url: "http://127.0.0.1:12345/",
        close: fixtureClose,
      })),
    ).rejects.toThrow("primary DOM failure");
    expect(cleanupWarning).toHaveBeenCalledWith(
      expect.stringContaining("browser shutdown rejected"),
    );
    expect(fixtureClose).toHaveBeenCalledOnce();
  });

  it("aggregates browser and fixture cleanup failures without skipping either", async () => {
    const browserError = new Error("browser shutdown rejected");
    const fixtureError = new Error("fixture shutdown rejected");
    const fixtureClose = vi.fn(async () => {
      throw fixtureError;
    });

    const cleanupError = await cleanupMacosBrowserEvidence(
      {
        async executeCommand(command: string) {
          expect(command).toBe("browser_close");
          throw browserError;
        },
      },
      { close: fixtureClose },
      true,
    );

    expect(fixtureClose).toHaveBeenCalledOnce();
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      browserError,
      fixtureError,
    ]);
  });
});
