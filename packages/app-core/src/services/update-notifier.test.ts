/**
 * Unit coverage for scheduleUpdateNotification, the fire-and-forget CLI
 * startup update check. Drives the real export: the one-shot `notified`
 * guard, checkOnStart / CI / TTY gates, malformed-config resilience, the
 * stderr notice (including non-stable channel suffix), and the J6 swallow
 * of a failed registry check. `@elizaos/agent` I/O is stubbed so the suite
 * never reads eliza.json or hits npm; the notifier itself is not mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  loadElizaConfig: vi.fn(),
  resolveChannel: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  checkForUpdate: agent.checkForUpdate,
  loadElizaConfig: agent.loadElizaConfig,
  resolveChannel: agent.resolveChannel,
}));

type UpdateCheckResult = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: "stable" | "beta" | "nightly";
  distTag: string;
  cached: boolean;
  error: string | null;
};

const stderr = process.stderr as NodeJS.WriteStream & { isTTY: boolean };
const ORIGINAL_CI = process.env.CI;
const ORIGINAL_IS_TTY = Boolean(stderr.isTTY);

function setStderrTty(value: boolean): void {
  stderr.isTTY = value;
}

function restoreCi(): void {
  if (ORIGINAL_CI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = ORIGINAL_CI;
  }
}

function stripAnsi(value: string): string {
  const esc = String.fromCharCode(27);
  return value.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

function captureStderrWrite(): {
  chunks: string[];
  restore: () => void;
} {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stderr.write);
  return {
    chunks,
    restore: () => {
      spy.mockRestore();
    },
  };
}

async function loadNotifier(): Promise<typeof import("./update-notifier")> {
  vi.resetModules();
  return import("./update-notifier");
}

function updateResult(
  overrides: Partial<UpdateCheckResult> = {},
): UpdateCheckResult {
  return {
    updateAvailable: true,
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    channel: "stable",
    distTag: "latest",
    cached: false,
    error: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function writtenText(chunks: string[]): string {
  return stripAnsi(chunks.join(""));
}

describe("scheduleUpdateNotification", () => {
  beforeEach(() => {
    agent.checkForUpdate.mockReset();
    agent.loadElizaConfig.mockReset();
    agent.resolveChannel.mockReset();
    agent.loadElizaConfig.mockReturnValue({});
    agent.resolveChannel.mockReturnValue("stable");
    agent.checkForUpdate.mockResolvedValue(updateResult());
    delete process.env.CI;
    setStderrTty(true);
  });

  afterEach(() => {
    restoreCi();
    setStderrTty(ORIGINAL_IS_TTY);
  });

  it("writes a two-line notice when a newer stable version is available", async () => {
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(agent.resolveChannel).toHaveBeenCalledWith(undefined);
      const text = writtenText(capture.chunks);
      expect(text).toContain("Update available:");
      expect(text).toContain("1.0.0 -> 1.1.0");
      expect(text).toContain("Run");
      expect(text).toContain("eliza update");
      expect(text).toContain("to install");
      expect(text).not.toContain("(stable)");
    } finally {
      capture.restore();
    }
  });

  it("appends the channel name when resolveChannel is not stable", async () => {
    agent.loadElizaConfig.mockReturnValue({
      update: { channel: "beta" },
    });
    agent.resolveChannel.mockReturnValue("beta");
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.resolveChannel).toHaveBeenCalledWith({ channel: "beta" });
      expect(writtenText(capture.chunks)).toContain("1.0.0 -> 1.1.0 (beta)");
    } finally {
      capture.restore();
    }
  });

  it("appends a nightly suffix the same way as beta", async () => {
    agent.resolveChannel.mockReturnValue("nightly");
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(writtenText(capture.chunks)).toContain("1.0.0 -> 1.1.0 (nightly)");
    } finally {
      capture.restore();
    }
  });

  it("stays silent when updateAvailable is false", async () => {
    agent.checkForUpdate.mockResolvedValue(
      updateResult({ updateAvailable: false, latestVersion: "1.0.0" }),
    );
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("stays silent when latestVersion is null even if updateAvailable is true", async () => {
    agent.checkForUpdate.mockResolvedValue(
      updateResult({ updateAvailable: true, latestVersion: null }),
    );
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("treats an empty latestVersion as missing and stays silent", async () => {
    agent.checkForUpdate.mockResolvedValue(
      updateResult({ updateAvailable: true, latestVersion: "" }),
    );
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("does not query the registry when checkOnStart is exactly false", async () => {
    agent.loadElizaConfig.mockReturnValue({
      update: { checkOnStart: false },
    });
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.loadElizaConfig).toHaveBeenCalledTimes(1);
      expect(agent.checkForUpdate).not.toHaveBeenCalled();
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("still queries when checkOnStart is true", async () => {
    agent.loadElizaConfig.mockReturnValue({
      update: { checkOnStart: true },
    });
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(writtenText(capture.chunks)).toContain("Update available:");
    } finally {
      capture.restore();
    }
  });

  it("does not treat a non-false checkOnStart (0) as an opt-out", async () => {
    agent.loadElizaConfig.mockReturnValue({
      update: { checkOnStart: 0 },
    });
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(writtenText(capture.chunks)).toContain("Update available:");
    } finally {
      capture.restore();
    }
  });

  it("does not query the registry when CI is set", async () => {
    process.env.CI = "1";
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).not.toHaveBeenCalled();
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("does not query the registry when stderr is not a TTY", async () => {
    setStderrTty(false);
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).not.toHaveBeenCalled();
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("continues with defaults when loadElizaConfig throws", async () => {
    agent.loadElizaConfig.mockImplementation(() => {
      throw new Error("malformed eliza.json");
    });
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(agent.resolveChannel).toHaveBeenCalledWith(undefined);
      expect(writtenText(capture.chunks)).toContain("1.0.0 -> 1.1.0");
    } finally {
      capture.restore();
    }
  });

  it("swallows a rejected checkForUpdate without writing", async () => {
    agent.checkForUpdate.mockRejectedValue(new Error("registry unreachable"));
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("is one-shot: a later call is a no-op even after CI is cleared", async () => {
    process.env.CI = "true";
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      expect(agent.loadElizaConfig).toHaveBeenCalledTimes(1);
      expect(agent.checkForUpdate).not.toHaveBeenCalled();

      delete process.env.CI;
      setStderrTty(true);
      agent.loadElizaConfig.mockClear();
      scheduleUpdateNotification();
      await flush();
      expect(agent.loadElizaConfig).not.toHaveBeenCalled();
      expect(agent.checkForUpdate).not.toHaveBeenCalled();
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it("does not query twice when the first call already printed a notice", async () => {
    const { scheduleUpdateNotification } = await loadNotifier();
    const capture = captureStderrWrite();
    try {
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(writtenText(capture.chunks)).toContain("Update available:");

      agent.checkForUpdate.mockClear();
      capture.chunks.length = 0;
      scheduleUpdateNotification();
      await flush();
      expect(agent.checkForUpdate).not.toHaveBeenCalled();
      expect(capture.chunks).toEqual([]);
    } finally {
      capture.restore();
    }
  });
});
