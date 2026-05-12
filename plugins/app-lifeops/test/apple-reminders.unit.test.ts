/**
 * Unit coverage for the native Apple Reminders FeatureResult contract.
 *
 * Spec contract:
 *   - non-darwin -> { ok: false, reason: "not_supported", platform }
 *   - native permission response -> { ok: false, reason: "permission",
 *       permission: "reminders", canRequest } and `recordBlock` is called.
 *   - native failure response -> { ok: false, reason: "native_error", message }
 *   - successful native response -> { ok: true, data: { provider, reminderId } }
 */

import type { IPermissionsRegistry, PermissionState } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createNativeAppleReminderLikeItem,
  deleteNativeAppleReminderLikeItem,
  updateNativeAppleReminderLikeItem,
} from "../src/lifeops/apple-reminders.ts";

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function fakeRegistry(state: Partial<PermissionState> = {}): {
  recordBlock: ReturnType<typeof vi.fn>;
  registry: IPermissionsRegistry;
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
  } as unknown as Parameters<
    typeof createNativeAppleReminderLikeItem
  >[0]["runtime"];
}

function setBridge(overrides: {
  create?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}): void {
  __testing.setNativeReminderBridgeForTest({
    create: overrides.create ?? vi.fn(() => JSON.stringify({ ok: true })),
    delete: overrides.delete ?? vi.fn(() => JSON.stringify({ ok: true })),
    update: overrides.update ?? vi.fn(() => JSON.stringify({ ok: true })),
  });
}

beforeEach(() => {
  setPlatform("darwin");
  __testing.setNativeReminderBridgeForTest(null);
});

afterEach(() => {
  __testing.setNativeReminderBridgeForTest(null);
  setPlatform(ORIGINAL_PLATFORM);
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
  });

  it("returns ok with reminderId on success", async () => {
    const create = vi.fn(() =>
      JSON.stringify({ ok: true, reminderId: "REMINDER-123" }),
    );
    setBridge({ create });
    const dueAt = new Date().toISOString();
    const result = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: "Call mom",
      dueAt,
    });
    expect(result).toEqual({
      ok: true,
      data: { provider: "apple_reminders", reminderId: "REMINDER-123" },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: "Created by Eliza.",
        priority: 5,
        title: "Call mom",
      }),
    );
  });

  it("returns permission failure when EventKit denies access", async () => {
    const create = vi.fn(() =>
      JSON.stringify({
        ok: false,
        error: "permission",
        message: "Apple Reminders access has not been granted.",
      }),
    );
    setBridge({ create });
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

  it("returns native_error for other native failures", async () => {
    setBridge({
      create: vi.fn(() =>
        JSON.stringify({
          ok: false,
          error: "native_error",
          message: "No writable Apple Reminders list is available.",
        }),
      ),
    });
    const result = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: "Call mom",
      dueAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("native_error");
    if (result.reason !== "native_error") return;
    expect(result.message).toContain("No writable Apple Reminders list");
  });
});

describe("updateNativeAppleReminderLikeItem permission denial", () => {
  it("records reminders.update on the registry", async () => {
    setBridge({
      update: vi.fn(() =>
        JSON.stringify({
          ok: false,
          error: "permission",
          message: "Apple Reminders access has not been granted.",
        }),
      ),
    });
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
    setBridge({
      delete: vi.fn(() =>
        JSON.stringify({
          ok: false,
          error: "permission",
          message: "Apple Reminders access has not been granted.",
        }),
      ),
    });
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
