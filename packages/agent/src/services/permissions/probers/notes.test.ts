/**
 * Unit coverage for the Notes.app Apple Events permission prober. Drives the
 * real `notesProber` so Darwin TCC classification, the null→not-determined
 * fallback, non-Darwin platform-unsupported short-circuit, and the request()
 * osascript path are asserted against live `buildState` /
 * `platformUnsupportedState` output. TCC.db and osascript collaborators are
 * faked so Darwin branches run on any host. `buildState` drops the free-text
 * `reason` option, so that field is asserted absent on returned states.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isDarwin: true,
  queryAppleEventsTccStatus: vi.fn(),
  runOsascript: vi.fn(),
}));

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return mocks.isDarwin;
    },
    queryAppleEventsTccStatus: mocks.queryAppleEventsTccStatus,
    runOsascript: mocks.runOsascript,
  };
});

import { platformUnsupportedState } from "./_bridge.js";
import { notesProber } from "./notes.ts";

const NOTES_BUNDLE_ID = "com.apple.Notes";
const NOTES_SCRIPT = 'tell application "Notes" to count of folders';

function expectPlatform(platform: string): void {
  expect(["darwin", "win32", "linux", "ios", "android", "web"]).toContain(
    platform,
  );
}

describe("notesProber", () => {
  beforeEach(() => {
    mocks.isDarwin = true;
    mocks.queryAppleEventsTccStatus.mockReset();
    mocks.runOsascript.mockReset();
    mocks.queryAppleEventsTccStatus.mockResolvedValue(null);
    mocks.runOsascript.mockResolvedValue("1");
  });

  it("exports id notes", () => {
    expect(notesProber.id).toBe("notes");
    expect(notesProber.openSettings).toBeUndefined();
    expect(typeof notesProber.check).toBe("function");
    expect(typeof notesProber.request).toBe("function");
  });

  describe("check", () => {
    it("returns platform-unsupported without querying TCC when not Darwin", async () => {
      mocks.isDarwin = false;
      const state = await notesProber.check();
      const expected = platformUnsupportedState("notes");
      expect(state).toEqual({
        ...expected,
        lastChecked: state.lastChecked,
      });
      expect(state.status).toBe("not-applicable");
      expect(state.canRequest).toBe(false);
      expect(state.restrictedReason).toBe("platform_unsupported");
      expect(state.lastRequested).toBeUndefined();
      expect(mocks.queryAppleEventsTccStatus).not.toHaveBeenCalled();
      expect(mocks.runOsascript).not.toHaveBeenCalled();
    });

    it("treats a missing Apple Events row as not-determined and requestable", async () => {
      mocks.queryAppleEventsTccStatus.mockResolvedValue(null);
      const before = Date.now();
      const state = await notesProber.check();
      expect(mocks.queryAppleEventsTccStatus).toHaveBeenCalledTimes(1);
      expect(mocks.queryAppleEventsTccStatus).toHaveBeenCalledWith(
        NOTES_BUNDLE_ID,
      );
      expect(mocks.runOsascript).not.toHaveBeenCalled();
      expect(state.id).toBe("notes");
      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
      expect(state.lastRequested).toBeUndefined();
      expect(state.reason).toBeUndefined();
      expect(state.lastChecked).toBeGreaterThanOrEqual(before);
      expectPlatform(state.platform);
    });

    it("reports granted as not requestable and does not surface reason", async () => {
      mocks.queryAppleEventsTccStatus.mockResolvedValue("granted");
      const state = await notesProber.check();
      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
      expect(state.reason).toBeUndefined();
      expect(state.restrictedReason).toBeUndefined();
      expect(state.lastRequested).toBeUndefined();
      expect(mocks.runOsascript).not.toHaveBeenCalled();
    });

    it("reports denied as not requestable", async () => {
      mocks.queryAppleEventsTccStatus.mockResolvedValue("denied");
      const state = await notesProber.check();
      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
      expect(state.reason).toBeUndefined();
      expect(state.lastRequested).toBeUndefined();
      expect(mocks.runOsascript).not.toHaveBeenCalled();
    });
  });

  describe("request", () => {
    it("returns platform-unsupported without running osascript when not Darwin", async () => {
      mocks.isDarwin = false;
      const state = await notesProber.request({ reason: "need notes" });
      const expected = platformUnsupportedState("notes");
      expect(state).toEqual({
        ...expected,
        lastChecked: state.lastChecked,
      });
      expect(state.lastRequested).toBeUndefined();
      expect(mocks.runOsascript).not.toHaveBeenCalled();
      expect(mocks.queryAppleEventsTccStatus).not.toHaveBeenCalled();
    });

    it("prompts Notes.app then re-reads TCC, stamping lastRequested", async () => {
      mocks.queryAppleEventsTccStatus.mockResolvedValue("granted");
      const before = Date.now();
      const state = await notesProber.request({ reason: "need notes" });
      const after = Date.now();
      expect(mocks.runOsascript).toHaveBeenCalledTimes(1);
      expect(mocks.runOsascript).toHaveBeenCalledWith(NOTES_SCRIPT);
      expect(mocks.queryAppleEventsTccStatus).toHaveBeenCalledTimes(1);
      expect(mocks.queryAppleEventsTccStatus).toHaveBeenCalledWith(
        NOTES_BUNDLE_ID,
      );
      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
      expect(state.lastRequested).toBeLessThanOrEqual(after);
      expect(state.reason).toBeUndefined();
      expectPlatform(state.platform);
    });

    it("keeps denied requestable=false after the prompt", async () => {
      mocks.queryAppleEventsTccStatus.mockResolvedValue("denied");
      const state = await notesProber.request({ reason: "need notes" });
      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toEqual(expect.any(Number));
      expect(mocks.runOsascript).toHaveBeenCalledWith(NOTES_SCRIPT);
    });

    it("keeps a missing TCC row requestable after the prompt", async () => {
      mocks.queryAppleEventsTccStatus.mockResolvedValue(null);
      const state = await notesProber.request({ reason: "need notes" });
      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
      expect(state.lastRequested).toEqual(expect.any(Number));
    });

    it("ignores osascript failure and still classifies from the TCC re-read", async () => {
      mocks.runOsascript.mockResolvedValue(null);
      mocks.queryAppleEventsTccStatus.mockResolvedValue("denied");
      const state = await notesProber.request({ reason: "need notes" });
      expect(mocks.runOsascript).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toEqual(expect.any(Number));
    });

    it("does not copy the caller reason onto the returned state", async () => {
      mocks.queryAppleEventsTccStatus.mockResolvedValue(null);
      const state = await notesProber.request({
        reason: "distinct-caller-reason",
      });
      expect(state.reason).toBeUndefined();
      expect(state.status).toBe("not-determined");
    });
  });
});
