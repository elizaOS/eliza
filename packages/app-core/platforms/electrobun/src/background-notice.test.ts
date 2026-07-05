/** Exercises one-shot desktop background notice behavior. */
import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_NOTICE_MARKER_FILE,
  hasSeenBackgroundNotice,
  markBackgroundNoticeSeen,
  resolveBackgroundNoticeMarkerPath,
  showBackgroundNoticeOnce,
} from "./background-notice";

function createMemoryFileSystem(initialFiles: string[] = []) {
  const files = new Set(initialFiles);
  return {
    files,
    existsSync: vi.fn((filePath: string) => files.has(filePath)),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((filePath: string) => {
      files.add(filePath);
    }),
  };
}

describe("background notice", () => {
  it("resolves and writes the user-data marker file", () => {
    const userDataDir = "/tmp/eliza-user-data";
    const markerPath = resolveBackgroundNoticeMarkerPath(userDataDir);
    const fileSystem = createMemoryFileSystem();

    expect(markerPath).toBe(
      `/tmp/eliza-user-data/${BACKGROUND_NOTICE_MARKER_FILE}`,
    );
    expect(hasSeenBackgroundNotice(fileSystem, userDataDir)).toBe(false);
    expect(markBackgroundNoticeSeen(fileSystem, userDataDir)).toBe(markerPath);
    expect(hasSeenBackgroundNotice(fileSystem, userDataDir)).toBe(true);
    expect(fileSystem.mkdirSync).toHaveBeenCalledWith(userDataDir, {
      recursive: true,
    });
    expect(fileSystem.writeFileSync).toHaveBeenCalledWith(
      markerPath,
      '{"seen":true}\n',
      "utf8",
    );
  });

  it("shows the close-to-tray notice only once", () => {
    const userDataDir = "/tmp/eliza-user-data";
    const fileSystem = createMemoryFileSystem();
    const showNotification = vi.fn();

    expect(
      showBackgroundNoticeOnce({
        fileSystem,
        userDataDir,
        showNotification,
      }),
    ).toBe(true);
    expect(
      showBackgroundNoticeOnce({
        fileSystem,
        userDataDir,
        showNotification,
      }),
    ).toBe(false);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]?.[0]).toMatchObject({
      title: expect.stringContaining("Still Running"),
      body: expect.stringContaining("running in the background"),
    });
  });
});
