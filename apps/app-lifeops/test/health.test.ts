import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("node:child_process");
  const { EventEmitter } = await import("node:events");
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
    ) => {
      const callback =
        typeof _opts === "function"
          ? (_opts as (err: NodeJS.ErrnoException | null, s: string, e: string) => void)
          : cb;
      const err: NodeJS.ErrnoException = Object.assign(
        new Error("not found"),
        { code: "ENOENT" },
      );
      callback?.(err, "", "");
      return new EventEmitter();
    },
  );
  return { ...actual, execFile, spawn: vi.fn() };
});

import {
  detectHealthBackend,
  getDailySummary,
  HealthBridgeError,
} from "../src/lifeops/health-bridge.js";
import { withHealth } from "../src/lifeops/service-mixin-health.js";
import { LifeOpsServiceError } from "../src/lifeops/service-types.js";
import { healthAction } from "../src/actions/health.js";

const ORIGINAL_ENV = { ...process.env };
const SAME_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (
      k.startsWith("ELIZA_HEALTHKIT") ||
      k.startsWith("ELIZA_GOOGLE_FIT") ||
      k === "MILADY_TEST_HEALTH_BACKEND" ||
      k === "MILADY_BENCHMARK_USE_MOCKS"
    ) {
      delete process.env[k];
    }
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("detectHealthBackend", () => {
  test('returns "none" when no env vars or binary configured', async () => {
    const backend = await detectHealthBackend();
    expect(backend).toBe("none");
  });

  test("does not enable fixture health data from benchmark mock mode", async () => {
    process.env.MILADY_BENCHMARK_USE_MOCKS = "1";

    const backend = await detectHealthBackend();

    expect(backend).toBe("none");
  });

  test("enables fixture health data only through explicit health test backend", async () => {
    process.env.MILADY_TEST_HEALTH_BACKEND = "fixture";

    const backend = await detectHealthBackend();

    expect(backend).toBe("fixture");
  });
});

describe("getDailySummary", () => {
  test('throws HealthBridgeError when backend is "none"', async () => {
    await expect(getDailySummary("2025-01-01")).rejects.toBeInstanceOf(
      HealthBridgeError,
    );
  });
});

describe("withHealth mixin", () => {
  // Minimal stub base mimicking LifeOpsServiceBase fields the mixin uses.
  class StubBase {
    runtime = { agentId: "test", logger: console };
    ownerEntityId = null;
  }

  const ComposedHealth = withHealth(StubBase as never);
  // biome-ignore lint/suspicious/noExplicitAny: mixin stub
  const svc = new (ComposedHealth as any)();

  test("getHealthConnectorStatus reports available: false without backend", async () => {
    const status = await svc.getHealthConnectorStatus();
    expect(status.available).toBe(false);
    expect(status.backend).toBe("none");
    expect(typeof status.lastCheckedAt).toBe("string");
  });

  test("getHealthDailySummary translates HealthBridgeError to LifeOpsServiceError", async () => {
    await expect(svc.getHealthDailySummary("2025-01-01")).rejects.toBeInstanceOf(
      LifeOpsServiceError,
    );
  });
});

describe("healthAction", () => {
  test("validate is owner-gated", async () => {
    const runtime = { agentId: SAME_ID } as unknown as Parameters<
      NonNullable<typeof healthAction.validate>
    >[0];
    const ownerMsg = {
      entityId: SAME_ID,
      content: { text: "" },
    } as unknown as Parameters<NonNullable<typeof healthAction.validate>>[1];
    expect(await healthAction.validate!(runtime, ownerMsg)).toBe(true);

    const otherMsg = {
      entityId: "00000000-0000-0000-0000-0000000000ff",
      content: { text: "" },
    } as unknown as Parameters<NonNullable<typeof healthAction.validate>>[1];
    expect(await healthAction.validate!(runtime, otherMsg)).toBe(false);
  });

  test("status subaction returns connector status text", async () => {
    const runtime = {
      agentId: SAME_ID,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      },
    } as unknown as Parameters<NonNullable<typeof healthAction.handler>>[0];
    const message = {
      entityId: SAME_ID,
      roomId: "00000000-0000-0000-0000-000000000002",
      content: { text: "is health connected?" },
    } as unknown as Parameters<NonNullable<typeof healthAction.handler>>[1];

    const result = await healthAction.handler!(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "status" } },
      undefined,
    );
    const r = result as {
      success: boolean;
      text: string;
      data?: { status?: { available?: boolean } };
    };
    expect(r.success).toBe(true);
    // Backend is "none" in this test, so the text says "No health backend".
    expect(r.text.toLowerCase()).toContain("health");
    expect(r.data?.status?.available).toBe(false);
  });
});
