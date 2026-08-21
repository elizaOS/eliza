// Exercises cloud DB jobs behavior with deterministic repository fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../../lib/storage/r2-runtime-binding";
import { prepareJobInsertData } from "./jobs";

const ENV_KEYS = [
  "SQL_HEAVY_PAYLOAD_STORAGE",
  "SQL_HEAVY_PAYLOAD_MIN_BYTES",
  "SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES",
  "SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function memoryBucket(objects: Map<string, string>): RuntimeR2Bucket {
  return {
    async get(key) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            async text() {
              return value;
            },
          };
    },
    async put(key, value) {
      objects.set(key, typeof value === "string" ? value : String(value ?? ""));
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

afterEach(() => {
  setRuntimeR2Bucket(null);
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("prepareJobInsertData", () => {
  test("preserves appId inline when job data is offloaded", async () => {
    const objects = new Map<string, string>();
    setRuntimeR2Bucket(memoryBucket(objects));
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
    process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES = "1";
    process.env.SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES = "0";

    const prepared = await prepareJobInsertData({
      id: "11111111-1111-4111-8111-111111111111",
      type: "app_deploy",
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      data: {
        appId: "app-123",
        buildContext: "x".repeat(1024),
      },
    });

    expect(prepared.data_storage).toBe("r2");
    expect(prepared.data_key).toContain("11111111-1111-4111-8111-111111111111/data.json");
    expect(prepared.data).toEqual({ appId: "app-123" });
    expect(objects.size).toBe(1);
    expect(JSON.parse([...objects.values()][0] ?? "{}")).toMatchObject({
      appId: "app-123",
      buildContext: expect.any(String),
    });
  });

  test("a failure dump can no longer be written whole into the error column", async () => {
    setRuntimeR2Bucket(null);
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
    process.env.SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES = "4096";

    const dump = "PGLITE-DUMP".repeat(5000);
    const prepared = await prepareJobInsertData({
      id: "44444444-4444-4444-8444-444444444444",
      type: "agent_snapshot",
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      data: { appId: "app-123" },
      error: dump,
    });

    expect(prepared.error_storage).toBe("inline");
    expect(prepared.error_key).toBeNull();
    const stored = prepared.error ?? "";
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(4096);
    expect(stored).toContain("truncated:");
    expect(stored.startsWith("PGLITE-DUMP")).toBe(true);
  });
});
