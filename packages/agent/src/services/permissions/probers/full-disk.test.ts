/**
 * Unit coverage for the Full Disk Access prober. Drives the real module
 * through Darwin probe ordering (Mail → Safari bookmarks → TCC.db),
 * directory versus file targets, EACCES/EPERM denial, missing-path and
 * non-access fallthrough, non-Darwin unsupported, and request() which
 * always opens the AllFiles pane. System Settings is stubbed; buildState
 * and platformUnsupportedState stay the production helpers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { darwin, mockOpenPrivacyPane } = vi.hoisted(() => ({
  darwin: { current: true },
  mockOpenPrivacyPane: vi.fn(),
}));

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return darwin.current;
    },
    openPrivacyPane: mockOpenPrivacyPane,
  };
});

import { fullDiskProber } from "./full-disk.ts";

function ioError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function mailDir(home: string): string {
  return path.join(home, "Library", "Mail");
}

function bookmarksFile(home: string): string {
  return path.join(home, "Library", "Safari", "Bookmarks.plist");
}

function tccDbFile(home: string): string {
  return path.join(
    home,
    "Library",
    "Application Support",
    "com.apple.TCC",
    "TCC.db",
  );
}

let tmpHome: string;

describe("fullDiskProber", () => {
  beforeEach(() => {
    darwin.current = true;
    mockOpenPrivacyPane.mockReset();
    mockOpenPrivacyPane.mockResolvedValue(undefined);
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "eliza-fda-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("exports id full-disk", () => {
    expect(fullDiskProber.id).toBe("full-disk");
    expect(typeof fullDiskProber.check).toBe("function");
    expect(typeof fullDiskProber.request).toBe("function");
  });
});

describe("fullDiskProber.check", () => {
  beforeEach(() => {
    darwin.current = true;
    mockOpenPrivacyPane.mockReset();
    mockOpenPrivacyPane.mockResolvedValue(undefined);
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "eliza-fda-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns not-applicable on non-Darwin without probing the filesystem", async () => {
    darwin.current = false;
    const stat = vi.spyOn(fs, "stat");
    const before = Date.now();
    const state = await fullDiskProber.check();
    expect(state).toMatchObject({
      id: "full-disk",
      status: "not-applicable",
      canRequest: false,
      restrictedReason: "platform_unsupported",
      platform: process.platform,
    });
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
    expect(os.homedir).not.toHaveBeenCalled();
  });

  it("returns not-determined with canRequest false when no FDA probe exists", async () => {
    const stat = vi.spyOn(fs, "stat");
    const state = await fullDiskProber.check();
    expect(state.id).toBe("full-disk");
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });

  it("grants when Library/Mail exists as a readable directory", async () => {
    mkdirSync(mailDir(tmpHome), { recursive: true });
    writeFileSync(path.join(mailDir(tmpHome), "Accounts.plist"), "mail");
    const open = vi.spyOn(fs, "open");
    const state = await fullDiskProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.id).toBe("full-disk");
    expect(open).not.toHaveBeenCalled();
  });

  it("does not consult later probes once Mail grants", async () => {
    mkdirSync(mailDir(tmpHome), { recursive: true });
    vi.spyOn(fs, "open").mockRejectedValue(ioError("EACCES"));
    const state = await fullDiskProber.check();
    expect(state.status).toBe("granted");
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("skips a missing Mail directory and grants via Safari Bookmarks.plist", async () => {
    mkdirSync(path.dirname(bookmarksFile(tmpHome)), { recursive: true });
    writeFileSync(bookmarksFile(tmpHome), "plist");
    const open = vi.spyOn(fs, "open");
    const state = await fullDiskProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(open).toHaveBeenCalledWith(bookmarksFile(tmpHome), "r");
  });

  it("skips the first two missing probes and grants via TCC.db", async () => {
    mkdirSync(path.dirname(tccDbFile(tmpHome)), { recursive: true });
    writeFileSync(tccDbFile(tmpHome), "db");
    const state = await fullDiskProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
  });

  it("treats Library/Mail as a file probe when it is not a directory", async () => {
    mkdirSync(path.dirname(mailDir(tmpHome)), { recursive: true });
    writeFileSync(mailDir(tmpHome), "not-a-dir");
    const readdir = vi.spyOn(fs, "readdir");
    const state = await fullDiskProber.check();
    expect(state.status).toBe("granted");
    expect(readdir).not.toHaveBeenCalled();
  });

  it("treats Bookmarks.plist as a directory probe when it is a directory", async () => {
    mkdirSync(bookmarksFile(tmpHome), { recursive: true });
    const open = vi.spyOn(fs, "open");
    const state = await fullDiskProber.check();
    expect(state.status).toBe("granted");
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM"] as const)(
    "returns denied when the Mail directory listing throws %s (does not fall through)",
    async (code) => {
      mkdirSync(mailDir(tmpHome), { recursive: true });
      mkdirSync(path.dirname(bookmarksFile(tmpHome)), { recursive: true });
      writeFileSync(bookmarksFile(tmpHome), "plist");
      vi.spyOn(fs, "readdir").mockRejectedValueOnce(ioError(code));
      const state = await fullDiskProber.check();
      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
    },
  );

  it.each(["EACCES", "EPERM"] as const)(
    "returns denied when a file probe open throws %s (does not fall through)",
    async (code) => {
      mkdirSync(path.dirname(bookmarksFile(tmpHome)), { recursive: true });
      writeFileSync(bookmarksFile(tmpHome), "plist");
      mkdirSync(path.dirname(tccDbFile(tmpHome)), { recursive: true });
      writeFileSync(tccDbFile(tmpHome), "db");
      vi.spyOn(fs, "open").mockRejectedValueOnce(ioError(code));
      const state = await fullDiskProber.check();
      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
    },
  );

  it.each(["ENOENT", "EIO"] as const)(
    "falls through to the next probe when stat throws %s",
    async (code) => {
      mkdirSync(mailDir(tmpHome), { recursive: true });
      mkdirSync(path.dirname(bookmarksFile(tmpHome)), { recursive: true });
      writeFileSync(bookmarksFile(tmpHome), "plist");
      vi.spyOn(fs, "stat").mockRejectedValueOnce(ioError(code));
      const state = await fullDiskProber.check();
      expect(state.status).toBe("granted");
    },
  );

  it("falls through when the error has no errno code", async () => {
    mkdirSync(mailDir(tmpHome), { recursive: true });
    mkdirSync(path.dirname(bookmarksFile(tmpHome)), { recursive: true });
    writeFileSync(bookmarksFile(tmpHome), "plist");
    vi.spyOn(fs, "stat").mockRejectedValueOnce(new Error("unexpected"));
    const state = await fullDiskProber.check();
    expect(state.status).toBe("granted");
  });

  it("does not invoke openPrivacyPane from check()", async () => {
    mkdirSync(mailDir(tmpHome), { recursive: true });
    await fullDiskProber.check();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });
});

describe("fullDiskProber.request", () => {
  beforeEach(() => {
    darwin.current = true;
    mockOpenPrivacyPane.mockReset();
    mockOpenPrivacyPane.mockResolvedValue(undefined);
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "eliza-fda-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns not-applicable on non-Darwin without lastRequested or a pane open", async () => {
    darwin.current = false;
    const state = await fullDiskProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-applicable");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.id).toBe("full-disk");
    expect(state.lastRequested).toBeUndefined();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });

  it("always opens the AllFiles pane then re-checks, even when already granted", async () => {
    mkdirSync(mailDir(tmpHome), { recursive: true });
    const before = Date.now();
    const state = await fullDiskProber.request({ reason: "unit-test" });
    const after = Date.now();
    expect(mockOpenPrivacyPane).toHaveBeenCalledTimes(1);
    expect(mockOpenPrivacyPane).toHaveBeenCalledWith("AllFiles");
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
  });

  it("opens the AllFiles pane when the re-check is not-determined", async () => {
    const state = await fullDiskProber.request({ reason: "unit-test" });
    expect(mockOpenPrivacyPane).toHaveBeenCalledWith("AllFiles");
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("opens the AllFiles pane when the re-check is denied", async () => {
    mkdirSync(mailDir(tmpHome), { recursive: true });
    vi.spyOn(fs, "readdir").mockRejectedValue(ioError("EACCES"));
    const state = await fullDiskProber.request({ reason: "unit-test" });
    expect(mockOpenPrivacyPane).toHaveBeenCalledTimes(1);
    expect(mockOpenPrivacyPane).toHaveBeenCalledWith("AllFiles");
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("ignores the unused reason argument", async () => {
    mkdirSync(mailDir(tmpHome), { recursive: true });
    const state = await fullDiskProber.request({
      reason: "any-caller-supplied-reason",
    });
    expect(state.status).toBe("granted");
    expect(mockOpenPrivacyPane).toHaveBeenCalledWith("AllFiles");
  });
});
