/** Verifies game-viewer iframe sandbox validation through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for {@link sanitizeGameViewerSandbox}: the server-supplied
 * viewer `sandbox` string must be token-allowlisted, and the sandbox-defeating
 * `allow-scripts` + `allow-same-origin` pairing must be stripped whenever the
 * viewer URL resolves same-origin with the shell (it lets framed content
 * rewrite its own sandbox and run with full host privilege). Deterministic
 * pure-function tests; only `window.location.origin` comes from jsdom.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GAME_VIEWER_SANDBOX,
  sanitizeGameViewerSandbox,
} from "./viewer-auth";

const SHELL_ORIGIN = window.location.origin;

describe("sanitizeGameViewerSandbox", () => {
  it("applies the default sandbox when the server sends none", () => {
    expect(
      sanitizeGameViewerSandbox(undefined, "https://games.example.com/run/1"),
    ).toBe(DEFAULT_GAME_VIEWER_SANDBOX);
    expect(
      sanitizeGameViewerSandbox(null, "https://games.example.com/run/1"),
    ).toBe(DEFAULT_GAME_VIEWER_SANDBOX);
  });

  it("keeps allow-scripts + allow-same-origin for genuinely cross-origin viewers", () => {
    expect(
      sanitizeGameViewerSandbox(
        "allow-scripts allow-same-origin",
        "https://games.example.com/run/1",
      ),
    ).toBe("allow-scripts allow-same-origin");
  });

  it("strips allow-same-origin when the viewer is same-origin with the shell", () => {
    expect(
      sanitizeGameViewerSandbox(
        "allow-scripts allow-same-origin allow-popups",
        `${SHELL_ORIGIN}/apps/feed/viewer`,
      ),
    ).toBe("allow-scripts allow-popups");
  });

  it("strips allow-same-origin from the default for root-relative viewers", () => {
    // A root-relative viewer path resolves against the shell origin.
    expect(sanitizeGameViewerSandbox(undefined, "/apps/feed/viewer")).toBe(
      "allow-scripts allow-popups",
    );
  });

  it("drops tokens outside the MDN sandbox vocabulary", () => {
    expect(
      sanitizeGameViewerSandbox(
        "allow-scripts allow-not-a-token allow-popups PLEASE-ALLOW-EVERYTHING",
        "https://games.example.com/run/1",
      ),
    ).toBe("allow-scripts allow-popups");
  });

  it("dedupes repeated tokens", () => {
    expect(
      sanitizeGameViewerSandbox(
        "allow-scripts allow-scripts allow-popups allow-popups",
        "https://games.example.com/run/1",
      ),
    ).toBe("allow-scripts allow-popups");
  });

  it("preserves an empty server string as a fully-locked-down sandbox", () => {
    expect(
      sanitizeGameViewerSandbox("", "https://games.example.com/run/1"),
    ).toBe("");
  });

  it("keeps allow-same-origin alone on same-origin viewers (no scripts to escape with)", () => {
    expect(
      sanitizeGameViewerSandbox(
        "allow-same-origin allow-forms",
        `${SHELL_ORIGIN}/apps/feed/viewer`,
      ),
    ).toBe("allow-same-origin allow-forms");
  });

  it("fails closed on an unparseable viewer URL", () => {
    // Origin cannot be proven distinct, so the dangerous pairing is stripped.
    expect(
      sanitizeGameViewerSandbox("allow-scripts allow-same-origin", "not a url"),
    ).toBe("allow-scripts");
  });
});
