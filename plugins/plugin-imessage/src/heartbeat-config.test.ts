/**
 * Verifies operator heartbeat configuration before it reaches recurring task scheduling.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMessageService, resolveBackfillRows, resolveHeartbeatIntervalMs } from "./service";
import { IMessageConfigurationError, type IMessageSettings } from "./types";

const { openChatDbMock } = vi.hoisted(() => ({
  openChatDbMock: vi.fn(),
}));

vi.mock("./chatdb-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatdb-reader.js")>()),
  openChatDb: openChatDbMock,
}));

const originalHeartbeatEnv = process.env.IMESSAGE_HEARTBEAT_INTERVAL_MS;
const originalBackfillEnv = process.env.IMESSAGE_BACKFILL;

afterEach(() => {
  vi.restoreAllMocks();
  openChatDbMock.mockReset();
  if (originalHeartbeatEnv === undefined) {
    delete process.env.IMESSAGE_HEARTBEAT_INTERVAL_MS;
  } else {
    process.env.IMESSAGE_HEARTBEAT_INTERVAL_MS = originalHeartbeatEnv;
  }
  if (originalBackfillEnv === undefined) {
    delete process.env.IMESSAGE_BACKFILL;
  } else {
    process.env.IMESSAGE_BACKFILL = originalBackfillEnv;
  }
});

describe("resolveHeartbeatIntervalMs", () => {
  it("uses the default when the setting is absent or blank", () => {
    expect(resolveHeartbeatIntervalMs(undefined)).toBe(60_000);
    expect(resolveHeartbeatIntervalMs("  ")).toBe(60_000);
  });

  it("accepts positive integer millisecond intervals", () => {
    expect(resolveHeartbeatIntervalMs(" 5000 ")).toBe(5_000);
    expect(resolveHeartbeatIntervalMs("2147483647")).toBe(2_147_483_647);
  });

  it("loads the per-runtime setting before the process environment", () => {
    process.env.IMESSAGE_HEARTBEAT_INTERVAL_MS = "9000";
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "IMESSAGE_HEARTBEAT_INTERVAL_MS" ? "7000" : undefined
      ),
    } as unknown as IAgentRuntime;
    const service = new IMessageService(runtime);
    const settings = (service as unknown as { loadSettings(): IMessageSettings }).loadSettings();

    expect(settings.heartbeatIntervalMs).toBe(7000);
  });

  it("rejects a bad runtime setting during settings load", () => {
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "IMESSAGE_HEARTBEAT_INTERVAL_MS" ? "Infinity" : undefined
      ),
    } as unknown as IAgentRuntime;
    const service = new IMessageService(runtime);

    expect(() =>
      (service as unknown as { loadSettings(): IMessageSettings }).loadSettings()
    ).toThrow(IMessageConfigurationError);
  });

  it.each(["0", "-1", "1.5", "1e3", "5000oops", "Infinity", "2147483648"])(
    "rejects invalid operator input %s",
    (raw) => {
      try {
        resolveHeartbeatIntervalMs(raw);
        throw new Error("expected heartbeat configuration to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(IMessageConfigurationError);
        expect(error).toMatchObject({
          code: "CONFIGURATION_ERROR",
          details: { setting: "IMESSAGE_HEARTBEAT_INTERVAL_MS" },
        });
        expect((error as Error).message).toMatch(/IMESSAGE_HEARTBEAT_INTERVAL_MS/);
      }
    }
  );
});

describe("resolveBackfillRows", () => {
  it("defaults only absent or blank input to no backfill", () => {
    expect(resolveBackfillRows(undefined)).toBe(0);
    expect(resolveBackfillRows("  ")).toBe(0);
  });

  it("accepts safe non-negative integer rows", () => {
    expect(resolveBackfillRows("0")).toBe(0);
    expect(resolveBackfillRows(" 42 ")).toBe(42);
    expect(resolveBackfillRows(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["Infinity", "NaN", "1e9", "+42", "-1", "1.5", "9007199254740992"])(
    "rejects invalid operator input %s",
    (raw) => {
      expect(() => resolveBackfillRows(raw)).toThrow(IMessageConfigurationError);
      try {
        resolveBackfillRows(raw);
      } catch (error) {
        expect(error).toMatchObject({
          code: "CONFIGURATION_ERROR",
          details: { setting: "IMESSAGE_BACKFILL" },
        });
      }
    }
  );

  it("fails invalid runtime configuration before opening chat.db", async () => {
    const servicePrototype = IMessageService.prototype as unknown as {
      isMacOS(): boolean;
    };
    vi.spyOn(servicePrototype, "isMacOS").mockReturnValue(true);
    const runtime = {
      getSetting: vi.fn((key: string) => (key === "IMESSAGE_BACKFILL" ? "Infinity" : undefined)),
    } as unknown as IAgentRuntime;

    await expect(IMessageService.start(runtime)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      details: { setting: "IMESSAGE_BACKFILL" },
    });
    expect(openChatDbMock).not.toHaveBeenCalled();
  });
});
