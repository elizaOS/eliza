/**
 * Unit coverage for the FeatureResult contract on apple-reminders.ts.
 *
 * Spec contract:
 *   - non-darwin → { ok: false, reason: "not_supported", platform }
 *   - osascript denial stderr → { ok: false, reason: "permission",
 *       permission: "reminders", canRequest } and `recordBlock` is called.
 *   - other osascript stderr → { ok: false, reason: "native_error", message }
 *   - successful exec → { ok: true, data: { provider, reminderId } }
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  __testing,
  createNativeAppleReminderLikeItem,
  deleteNativeAppleReminderLikeItem,
  updateNativeAppleReminderLikeItem,
} from "../src/lifeops/apple-reminders.ts";
import type { IPermissionsRegistry } from "@elizaos/agent";
import type { PermissionState } from "@elizaos/shared";

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function makeError(stderr: string): NodeJS.ErrnoException & { stderr: string } {
  const err = new Error("osascript failed") as NodeJS.ErrnoException & {
    stderr: string;
  };
  err.stderr = stderr;
  return err;
}

function fakeRegistry(state: Partial<PermissionState> = {}): {
  registry: IPermissionsRegistry;
  recordBlock: ReturnType<typeof vi.fn>;
} {
  const recordBlock = vi.fn();
  const registry: IPermissionsRegistry = {
    get: vi.fn(
      () =>
        ({
          id: "reminders",
          status: "denied",
          canRequest: false,
          lastChecked: Date.now(),
          platform: "darwin",
          ...state,
        }) as PermissionState,
    ),
    check: vi.fn(),
    request: vi.fn(),
    recordBlock,
    list: vi.fn(() => []),
    pending: vi.fn(() => []),
    subscribe: vi.fn(() => () => undefined),
    registerProber: vi.fn(),
  };
  return { registry, recordBlock };
}

function fakeRuntime(registry: IPermissionsRegistry | null) {
  return {
    getService: vi.fn(() => registry),
  } as unknown as Parameters<typeof createNativeAppleReminderLikeItem>[0]["runtime"];
}

beforeEach(() => {
  execFileMock.mockReset();
  setPlatform("darwin");
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

describe("isPermissionDeniedStderr", () => {
  it("matches the canonical macOS denial line", () => {
    expect(
      __testing.isPermissionDeniedStderr(
        "execution error: Not authorized to send Apple events to Reminders. (-1743)",
      ),
    ).toBe(true);
  });

  it("matches via the numeric error code only", () => {
    expect(
      __testing.isPermissionDeniedStderr("execution error: foo (-1743)"),
    ).toBe(true);
  });

  it("does not match unrelated stderr", () => {
    expect(
      __testing.isPermissionDeniedStderr(
        "execution error: Reminder not found. (-2700)",
      ),
    ).toBe(false);
  });
});

describe("createNativeAppleReminderLikeItem", () => {
  it("returns not_supported off macOS", async () => {
    setPlatform("linux");
    const result = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: "test",
      dueAt: new Date().toISOString(),
    });
    expect(result).toEqual({
      ok: false,
      reason: "not_supported",
      platform: "linux",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns ok with reminderId on success", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, out: { stdout: string }) => void,
      ) => {
        cb(null, { stdout: "REMINDER-123\n" });
      },
    );
    const result = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: "Call mom",
      dueAt: new Date().toISOString(),
    });
    expect(result).toEqual({
      ok: true,
      data: { provider: "apple_reminders", reminderId: "REMINDER-123" },
    });
  });

  it("returns permission failure when osascript denies access", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: NodeJS.ErrnoException, out: unknown) => void,
      ) => {
        cb(
          makeError(
            "execution error: Not authorized to send Apple events to Reminders. (-1743)",
          ),
          undefined,
        );
      },
    );
    const { registry, recordBlock } = fakeRegistry({ canRequest: false });
    const result = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: "Call mom",
      dueAt: new Date().toISOString(),
      runtime: fakeRuntime(registry),
    });
    expect(result).toEqual({
      ok: false,
      reason: "permission",
      permission: "reminders",
      canRequest: false,
    });
    expect(recordBlock).toHaveBeenCalledWith("reminders", {
      app: "lifeops",
      action: "reminders.create",
    });
  });

  it("returns native_error for other osascript failures", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: NodeJS.ErrnoException, out: unknown) => void,
      ) => {
        cb(makeError("execution error: syntax error (-2741)"), undefined);
      },
    );
    const result = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: "Call mom",
      dueAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("native_error");
    if (result.reason !== "native_error") return;
    expect(result.message).toContain("syntax error");
  });
});

describe("updateNativeAppleReminderLikeItem permission denial", () => {
  it("records reminders.update on the registry", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: NodeJS.ErrnoException, out: unknown) => void,
      ) => {
        cb(
          makeError(
            "execution error: Not authorized to send Apple events to Reminders. (-1743)",
          ),
          undefined,
        );
      },
    );
    const { registry, recordBlock } = fakeRegistry({ canRequest: true });
    const result = await updateNativeAppleReminderLikeItem({
      reminderId: "r-1",
      kind: "reminder",
      title: "Call mom",
      dueAt: new Date().toISOString(),
      runtime: fakeRuntime(registry),
    });
    expect(result).toEqual({
      ok: false,
      reason: "permission",
      permission: "reminders",
      canRequest: true,
    });
    expect(recordBlock).toHaveBeenCalledWith("reminders", {
      app: "lifeops",
      action: "reminders.update",
    });
  });
});

describe("deleteNativeAppleReminderLikeItem permission denial", () => {
  it("records reminders.delete on the registry", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: NodeJS.ErrnoException, out: unknown) => void,
      ) => {
        cb(
          makeError(
            "execution error: Not authorized to send Apple events to Reminders. (-1743)",
          ),
          undefined,
        );
      },
    );
    const { registry, recordBlock } = fakeRegistry();
    const result = await deleteNativeAppleReminderLikeItem("r-1", {
      runtime: fakeRuntime(registry),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("permission");
    expect(recordBlock).toHaveBeenCalledWith("reminders", {
      app: "lifeops",
      action: "reminders.delete",
    });
  });
});
