/**
 * Exercises getFileWatcher against the real WorkspaceFileWatcher module.
 * Lifecycle, ignore rules, and event classification run through the captured
 * fs.watch listener plus real temp directories; one case writes the live
 * filesystem so the watcher wiring is not stubbed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileChangeEvent, getFileWatcher } from "./file-watcher";

type WatchListener = (
  eventName: string,
  filename: string | Buffer | null,
) => void;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-file-watcher-"));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function captureStart(
  watchPath: string,
  send: (event: FileChangeEvent) => void,
): { watchId: string; listener: WatchListener } {
  const close = vi.fn();
  let listener: WatchListener | undefined;
  vi.spyOn(fs, "watch").mockImplementation(((
    _filename: fs.PathLike,
    options?: unknown,
    cb?: WatchListener,
  ) => {
    listener = (typeof options === "function" ? options : cb) as WatchListener;
    return { close } as unknown as fs.FSWatcher;
  }) as unknown as typeof fs.watch);

  try {
    const watchId = getFileWatcher().startWatch(watchPath, send);
    if (typeof listener !== "function") {
      throw new Error(
        "WorkspaceFileWatcher did not pass a listener to fs.watch",
      );
    }
    return { watchId, listener };
  } finally {
    vi.mocked(fs.watch).mockRestore();
  }
}

async function flushDebounce(): Promise<void> {
  await delay(75);
}

beforeEach(() => {
  getFileWatcher().stopAll();
});

afterEach(() => {
  getFileWatcher().stopAll();
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("getFileWatcher", () => {
  it("returns a stable singleton", () => {
    expect(getFileWatcher()).toBe(getFileWatcher());
  });
});

describe("WorkspaceFileWatcher lifecycle", () => {
  it("lists an empty queue when no watches are active", () => {
    expect(getFileWatcher().listWatches()).toEqual([]);
  });

  it("throws when startWatch is given a path that does not exist", () => {
    const missing = path.join(makeTempDir(), "does-not-exist");
    expect(() => getFileWatcher().startWatch(missing, vi.fn())).toThrow(
      `Watch path does not exist: ${missing}`,
    );
    expect(getFileWatcher().listWatches()).toEqual([]);
  });

  it("starts a single watch with an incrementing watch_ id and active status", () => {
    const dir = makeTempDir();
    const before = Date.now();
    const watchId = getFileWatcher().startWatch(dir, vi.fn());

    expect(watchId).toMatch(/^watch_\d+$/);
    const listed = getFileWatcher().listWatches();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      watchId,
      watchPath: dir,
      active: true,
      startedAt: expect.any(Number),
      eventCount: 0,
    });
    expect(listed[0]?.startedAt).toBeGreaterThanOrEqual(before);
    expect(getFileWatcher().getWatch(watchId)).toEqual(listed[0]);
  });

  it("keeps insertion order for multiple watches and issues distinct ids", () => {
    const firstDir = makeTempDir();
    const secondDir = makeTempDir();
    const firstId = getFileWatcher().startWatch(firstDir, vi.fn());
    const secondId = getFileWatcher().startWatch(secondDir, vi.fn());
    const firstN = Number(firstId.slice("watch_".length));
    const secondN = Number(secondId.slice("watch_".length));

    expect(firstId).not.toBe(secondId);
    expect(secondN).toBe(firstN + 1);
    expect(
      getFileWatcher()
        .listWatches()
        .map((entry) => entry.watchId),
    ).toEqual([firstId, secondId]);
  });

  it("allows two watches on the same path without collapsing them", () => {
    const dir = makeTempDir();
    const firstId = getFileWatcher().startWatch(dir, vi.fn());
    const secondId = getFileWatcher().startWatch(dir, vi.fn());

    expect(firstId).not.toBe(secondId);
    expect(getFileWatcher().listWatches()).toHaveLength(2);
    expect(getFileWatcher().getWatch(firstId)?.watchPath).toBe(dir);
    expect(getFileWatcher().getWatch(secondId)?.watchPath).toBe(dir);
  });

  it("returns null for a missing watch id", () => {
    expect(getFileWatcher().getWatch("watch_missing")).toBeNull();
    expect(getFileWatcher().getWatch("watch_0")).toBeNull();
  });

  it("returns false when stopWatch cannot find the id", () => {
    expect(getFileWatcher().stopWatch("watch_missing")).toBe(false);
    expect(getFileWatcher().stopWatch("")).toBe(false);
  });

  it("stopWatch removes only the named watch and returns true", () => {
    const keepDir = makeTempDir();
    const dropDir = makeTempDir();
    const keepId = getFileWatcher().startWatch(keepDir, vi.fn());
    const dropId = getFileWatcher().startWatch(dropDir, vi.fn());

    expect(getFileWatcher().stopWatch(dropId)).toBe(true);
    expect(getFileWatcher().getWatch(dropId)).toBeNull();
    expect(getFileWatcher().stopWatch(dropId)).toBe(false);
    expect(
      getFileWatcher()
        .listWatches()
        .map((entry) => entry.watchId),
    ).toEqual([keepId]);
  });

  it("stopAll is a no-op on an empty map and clears every active watch", () => {
    expect(() => getFileWatcher().stopAll()).not.toThrow();
    expect(getFileWatcher().listWatches()).toEqual([]);

    getFileWatcher().startWatch(makeTempDir(), vi.fn());
    getFileWatcher().startWatch(makeTempDir(), vi.fn());
    getFileWatcher().stopAll();
    expect(getFileWatcher().listWatches()).toEqual([]);
  });
});

describe("WorkspaceFileWatcher event classification", () => {
  it("drops callbacks that omit a filename", async () => {
    const send = vi.fn();
    const { listener } = captureStart(makeTempDir(), send);

    listener("rename", null);
    listener("change", "");
    await flushDebounce();

    expect(send).not.toHaveBeenCalled();
  });

  it("classifies rename of an existing file as created", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { watchId, listener } = captureStart(dir, send);
    const relative = "new-file.txt";
    fs.writeFileSync(path.join(dir, relative), "hello");

    listener("rename", relative);
    await flushDebounce();

    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[0] as FileChangeEvent;
    expect(event).toMatchObject({
      watchId,
      type: "created",
      relativePath: relative,
      filePath: path.resolve(dir, relative),
    });
    expect(event.timestamp).toEqual(expect.any(Number));
    expect(getFileWatcher().getWatch(watchId)?.eventCount).toBe(1);
  });

  it("classifies change of an existing file as modified", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { listener } = captureStart(dir, send);
    const relative = "existing.txt";
    fs.writeFileSync(path.join(dir, relative), "v1");

    listener("change", relative);
    await flushDebounce();

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "modified",
      relativePath: relative,
    });
  });

  it("classifies a non-rename event name of an existing file as modified", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { listener } = captureStart(dir, send);
    const relative = "other.txt";
    fs.writeFileSync(path.join(dir, relative), "x");

    listener("other", relative);
    await flushDebounce();

    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: "modified" });
  });

  it("classifies a missing file as deleted regardless of event name", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { listener } = captureStart(dir, send);

    listener("rename", "gone.txt");
    listener("change", "also-gone.txt");
    await flushDebounce();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[0].type)).toEqual([
      "deleted",
      "deleted",
    ]);
  });

  it("keeps nested relative paths when the file lives in a subdirectory", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { listener } = captureStart(dir, send);
    const relative = path.join("src", "app.ts");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, relative), "export {}");

    listener("rename", relative);
    await flushDebounce();

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "created",
      relativePath: relative,
      filePath: path.resolve(dir, relative),
    });
  });

  it("ignores node_modules, dist, and hidden path segments", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { listener } = captureStart(dir, send);
    const ignored = [
      path.join("node_modules", "pkg", "index.js"),
      path.join("dist", "out.js"),
      path.join("build", "out.js"),
      path.join("out", "out.js"),
      path.join(".git", "HEAD"),
      path.join(".cache", "x"),
      ".env",
      path.join("src", ".hidden.ts"),
    ];
    for (const relative of ignored) {
      const full = path.join(dir, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "ignored");
      listener("rename", relative);
    }
    await flushDebounce();

    expect(send).not.toHaveBeenCalled();
  });

  it("still reports a regular file next to an ignored sibling", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { listener } = captureStart(dir, send);
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "no");
    fs.writeFileSync(path.join(dir, "readme.txt"), "yes");

    listener("rename", path.join("node_modules", "x.js"));
    listener("rename", "readme.txt");
    await flushDebounce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "created",
      relativePath: "readme.txt",
    });
  });
});

describe("WorkspaceFileWatcher debounce", () => {
  it("coalesces rapid events for one path and keeps the last type", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { watchId, listener } = captureStart(dir, send);
    const relative = "burst.txt";
    fs.writeFileSync(path.join(dir, relative), "x");

    listener("rename", relative);
    listener("change", relative);
    await flushDebounce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "modified",
      relativePath: relative,
    });
    expect(getFileWatcher().getWatch(watchId)?.eventCount).toBe(1);
  });

  it("does not share a debounce key across two files", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { listener } = captureStart(dir, send);
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    fs.writeFileSync(path.join(dir, "b.txt"), "b");

    listener("rename", "a.txt");
    listener("rename", "b.txt");
    await flushDebounce();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[0].relativePath).sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("still delivers a pending send after stopWatch but does not count it", async () => {
    const dir = makeTempDir();
    const send = vi.fn();
    const { watchId, listener } = captureStart(dir, send);
    fs.writeFileSync(path.join(dir, "late.txt"), "x");

    listener("change", "late.txt");
    expect(getFileWatcher().stopWatch(watchId)).toBe(true);
    await flushDebounce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      watchId,
      type: "modified",
      relativePath: "late.txt",
    });
    expect(getFileWatcher().getWatch(watchId)).toBeNull();
    expect(getFileWatcher().listWatches()).toEqual([]);
  });
});

describe("WorkspaceFileWatcher live fs.watch wiring", () => {
  it("emits after a real file is written in the watched directory", async () => {
    const dir = makeTempDir();
    const events: FileChangeEvent[] = [];
    const watchId = getFileWatcher().startWatch(dir, (event) => {
      events.push(event);
    });
    await delay(50);
    fs.writeFileSync(path.join(dir, "live.txt"), "hello");

    const deadline = Date.now() + 2000;
    while (
      !events.some((event) => event.relativePath === "live.txt") &&
      Date.now() < deadline
    ) {
      await delay(25);
    }

    const matched = events.filter(
      (event) => event.watchId === watchId && event.relativePath === "live.txt",
    );
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(["created", "modified"]).toContain(matched[0]?.type);
    expect(getFileWatcher().getWatch(watchId)?.eventCount).toBeGreaterThan(0);
  });
});
