/** Exercises strict pointer hydration without changing legacy fallback callers. */

import { afterEach, describe, expect, test } from "bun:test";
import { hydrateJsonField, hydrateTextField, ObjectStorageLifecycleError } from "./object-store";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "./r2-runtime-binding";

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
    async put() {
      return {};
    },
    async delete() {
      return {};
    },
  };
}

afterEach(() => setRuntimeR2Bucket(null));

describe("strict field hydration", () => {
  test("rejects missing keys and missing objects instead of publishing placeholders", async () => {
    setRuntimeR2Bucket(memoryBucket(new Map()));

    await expect(
      hydrateTextField({ storage: "r2", key: null, inlineValue: "preview", strict: true }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_FIELD_POINTER_INVALID" });
    await expect(
      hydrateJsonField({
        storage: "r2",
        key: "phone-message-payloads/org/date/id/metadata.json",
        inlineValue: {},
        strict: true,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_FIELD_UNAVAILABLE" });
  });

  test("rejects malformed hydrated JSON with a typed cause-preserving error", async () => {
    const key = "phone-message-payloads/org/date/id/metadata.json";
    setRuntimeR2Bucket(memoryBucket(new Map([[key, "not-json"]])));

    try {
      await hydrateJsonField({ storage: "r2", key, inlineValue: {}, strict: true });
      throw new Error("Expected malformed JSON");
    } catch (error) {
      // error-policy:J3 the test inspects the typed invalid-storage boundary.
      expect(error).toBeInstanceOf(ObjectStorageLifecycleError);
      expect(error).toMatchObject({ code: "OBJECT_STORAGE_FIELD_JSON_INVALID" });
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  test("preserves fallback semantics for existing non-strict callers", async () => {
    setRuntimeR2Bucket(memoryBucket(new Map()));
    await expect(
      hydrateTextField({ storage: "r2", key: "missing", inlineValue: "preview" }),
    ).resolves.toBe("preview");
    await expect(
      hydrateJsonField({ storage: "r2", key: "missing", inlineValue: { preview: true } }),
    ).resolves.toEqual({ preview: true });
  });
});
