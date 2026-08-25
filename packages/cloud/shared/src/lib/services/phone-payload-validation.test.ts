/** Exercises fail-closed phone JSON validation with deterministic adversarial values. */

import { describe, expect, test } from "bun:test";
import {
  PHONE_GATEWAY_METADATA_INVALID,
  PHONE_MESSAGE_MEDIA_URLS_INVALID,
  PHONE_MESSAGE_METADATA_INVALID,
  requirePhoneJsonObject,
  validatePhoneMediaUrls,
  validatePhoneMessageMetadata,
} from "./phone-payload-validation";

describe("phone message metadata validation", () => {
  test("preserves valid empty and oversized metadata without truncating it", () => {
    expect(validatePhoneMessageMetadata(undefined)).toEqual({});
    expect(validatePhoneMessageMetadata({})).toEqual({});

    const metadata = { trace: "x".repeat(32 * 1024), attempts: [1, 2, 3] };
    expect(validatePhoneMessageMetadata(metadata)).toBe(metadata);
  });

  test("rejects null, nested, undefined, non-finite, and cyclic metadata", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparseScalars = new Array<string>(2);
    sparseScalars[1] = "present";
    for (const metadata of [
      null,
      [],
      { nested: { value: true } },
      { missing: undefined },
      { nonFinite: Number.POSITIVE_INFINITY },
      { sparseScalars },
      cyclic,
    ]) {
      expect(() => validatePhoneMessageMetadata(metadata)).toThrow();
      try {
        validatePhoneMessageMetadata(metadata);
      } catch (error) {
        // error-policy:J3 the test inspects the typed invalid-input boundary.
        expect(error).toMatchObject({ code: PHONE_MESSAGE_METADATA_INVALID });
      }
    }
  });

  test("never embeds rejected metadata contents in the typed error", () => {
    const secret = "provider-token-that-must-not-appear";
    try {
      validatePhoneMessageMetadata({ nested: { secret } });
      throw new Error("Expected invalid metadata");
    } catch (error) {
      // error-policy:J3 the test inspects the typed invalid-input boundary.
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe("phone JSON shape validation", () => {
  test("accepts only arrays of strings for media URLs", () => {
    expect(validatePhoneMediaUrls(undefined)).toBeNull();
    expect(validatePhoneMediaUrls(null)).toBeNull();
    expect(validatePhoneMediaUrls([])).toEqual([]);
    expect(validatePhoneMediaUrls(["https://media.example/a"])).toEqual([
      "https://media.example/a",
    ]);

    const sparseMedia = new Array<string>(2);
    sparseMedia[1] = "https://media.example/present";
    for (const media of [{}, ["ok", 1], "[]", sparseMedia]) {
      try {
        validatePhoneMediaUrls(media);
        throw new Error("Expected invalid media URLs");
      } catch (error) {
        // error-policy:J3 the test inspects the typed invalid-input boundary.
        expect(error).toMatchObject({ code: PHONE_MESSAGE_MEDIA_URLS_INVALID });
      }
    }
  });

  test("validates arbitrary gateway metadata as lossless JSON objects", () => {
    const metadata = { nested: { enabled: true }, list: [null, "ok", 1] };
    expect(
      requirePhoneJsonObject(metadata, {
        field: "phone_gateway_devices.metadata",
        code: PHONE_GATEWAY_METADATA_INVALID,
      }),
    ).toBe(metadata);

    try {
      requirePhoneJsonObject(
        { missing: undefined },
        {
          field: "phone_gateway_devices.metadata",
          code: PHONE_GATEWAY_METADATA_INVALID,
        },
      );
      throw new Error("Expected invalid gateway metadata");
    } catch (error) {
      // error-policy:J3 the test inspects the typed invalid-input boundary.
      expect(error).toMatchObject({ code: PHONE_GATEWAY_METADATA_INVALID });
    }

    const sparseNested = new Array<string>(2);
    sparseNested[1] = "present";
    expect(() =>
      requirePhoneJsonObject(
        { sparseNested },
        {
          field: "phone_gateway_devices.metadata",
          code: PHONE_GATEWAY_METADATA_INVALID,
        },
      ),
    ).toThrow();
  });
});
