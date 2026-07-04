/**
 * Verifies the macOS-only platform guards short-circuit (non-Darwin, missing
 * hosts file) for apple-reminders and website-blocker. Deterministic vitest with
 * `@elizaos/core` mocked to avoid loading the full runtime.
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @elizaos/core so loading apple-reminders/website-blocker does not pull
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

function overridePlatform(platform: NodeJS.Platform): void {
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

// Reset the module registry before every test so that any guard which captures
// `process.platform` at module-init time (instead of at call time) still sees
// the per-test platform override. Today `isDarwin()` reads the value lazily,
// but this keeps the suite valid if that guard subsequent moves to module init.
beforeEach(() => {
  vi.resetModules();
});

describe("platform/host helper", () => {
  afterEach(() => {
    restorePlatform();
  });

  it("isDarwin returns true on darwin", async () => {
    overridePlatform("darwin");
    const { isDarwin } = await import("../platform/host.js");
    expect(isDarwin()).toBe(true);
  });

  it("isDarwin returns false on win32", async () => {
    overridePlatform("win32");
    const { isDarwin } = await import("../platform/host.js");
    expect(isDarwin()).toBe(false);
  });

  it("isDarwin returns false on linux", async () => {
    overridePlatform("linux");
    const { isDarwin } = await import("../platform/host.js");
    expect(isDarwin()).toBe(false);
  });

  it("darwinUnavailableActionResult returns the PLATFORM_UNSUPPORTED shape", async () => {
    overridePlatform("win32");
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
    overridePlatform("win32");
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
    overridePlatform("win32");
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
    overridePlatform("win32");
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
    overridePlatform("win32");
    const { getSelfControlStatus } = await import(
      "@elizaos/plugin-blocker/services/website-blocker/engine"
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
