import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stub @elizaos/core so loading apple-reminders/website-blocker does not pull
// in the full runtime logger transitive (adze, etc.) — these tests only
// exercise the early `if (!isDarwin())` and missing-hosts-file branches.
vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const ORIGINAL_PLATFORM = process.platform;

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: ORIGINAL_PLATFORM,
  });
}

describe("platform/host helper", () => {
  afterEach(() => {
    restorePlatform();
  });

  it("isDarwin returns true on darwin", async () => {
    stubPlatform("darwin");
    const { isDarwin } = await import("../platform/host.js");
    expect(isDarwin()).toBe(true);
  });

  it("isDarwin returns false on win32", async () => {
    stubPlatform("win32");
    const { isDarwin } = await import("../platform/host.js");
    expect(isDarwin()).toBe(false);
  });

  it("isDarwin returns false on linux", async () => {
    stubPlatform("linux");
    const { isDarwin } = await import("../platform/host.js");
    expect(isDarwin()).toBe(false);
  });

  it("darwinUnavailableActionResult returns the PLATFORM_UNSUPPORTED shape", async () => {
    stubPlatform("win32");
    const { darwinUnavailableActionResult } = await import(
      "../platform/host.js"
    );
    const result = darwinUnavailableActionResult({
      actionName: "CONNECTOR",
      connector: "imessage",
      subaction: "status",
      feature: "iMessage",
    });
    expect(result.success).toBe(false);
    expect(typeof result.text).toBe("string");
    const data = (result.data ?? {}) as Record<string, unknown>;
    expect(data.error).toBe("PLATFORM_UNSUPPORTED");
    expect(data.actionName).toBe("CONNECTOR");
    expect(data.connector).toBe("imessage");
    expect(data.subaction).toBe("status");
    expect(data.platform).toBe("win32");
  });
});

describe("platform guards — apple reminders bridge", () => {
  afterEach(() => {
    restorePlatform();
  });

  it("createNativeAppleReminderLikeItem returns not_supported on win32", async () => {
    stubPlatform("win32");
    const { createNativeAppleReminderLikeItem } = await import(
      "../lifeops/apple-reminders.js"
    );
    const result = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: "ignored",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_supported");
    }
  });

  it("updateNativeAppleReminderLikeItem returns not_supported on win32", async () => {
    stubPlatform("win32");
    const { updateNativeAppleReminderLikeItem } = await import(
      "../lifeops/apple-reminders.js"
    );
    const result = await updateNativeAppleReminderLikeItem({
      reminderId: "abc",
      kind: "reminder",
      title: "ignored",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_supported");
    }
  });

  it("deleteNativeAppleReminderLikeItem returns not_supported on win32", async () => {
    stubPlatform("win32");
    const { deleteNativeAppleReminderLikeItem } = await import(
      "../lifeops/apple-reminders.js"
    );
    const result = await deleteNativeAppleReminderLikeItem("abc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_supported");
    }
  });
});

describe("platform guards — website blocker engine", () => {
  afterEach(() => {
    restorePlatform();
  });

  it("reports unavailable when the hosts file path is missing on win32", async () => {
    stubPlatform("win32");
    const { getSelfControlStatus } = await import(
      "../website-blocker/engine.js"
    );
    const missing = path.join(
      os.tmpdir(),
      `lifeops-missing-hosts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const status = await getSelfControlStatus({ hostsFilePath: missing });
    expect(status.available).toBe(false);
    expect(status.platform).toBe("win32");
    expect(typeof status.reason).toBe("string");
  });
});
