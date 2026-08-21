/**
 * Exercises metadata sanitization for cloud managed gateway relay RPC requests,
 * proving circular, throwing, or invalid JSON records safely fail closed to undefined.
 */
import { describe, expect, it } from "vitest";
import { toJsonMetadataRecord } from "../../src/services/cloud-managed-gateway-relay";

describe("toJsonMetadataRecord", () => {
  it("returns undefined for non-record inputs", () => {
    expect(toJsonMetadataRecord(null)).toBeUndefined();
    expect(toJsonMetadataRecord(undefined)).toBeUndefined();
    expect(toJsonMetadataRecord("string")).toBeUndefined();
    expect(toJsonMetadataRecord(123)).toBeUndefined();
    expect(toJsonMetadataRecord(true)).toBeUndefined();
    expect(toJsonMetadataRecord([1, 2, 3])).toBeUndefined();
  });

  it("safely serializes valid metadata records", () => {
    const valid = {
      channelId: "12345",
      isDirect: true,
      count: 42,
      tags: ["alpha", "beta"],
      nested: { key: "value" },
    };

    expect(toJsonMetadataRecord(valid)).toEqual(valid);
  });

  it("fails closed to undefined on circular structures without throwing", () => {
    const circular: Record<string, unknown> = {
      name: "alice",
    };
    circular.self = circular;

    expect(toJsonMetadataRecord(circular)).toBeUndefined();
  });

  it("fails closed to undefined on objects with throwing getters", () => {
    const throwingObj = {
      get badProperty() {
        throw new Error("trap");
      },
    };

    expect(toJsonMetadataRecord(throwingObj)).toBeUndefined();
  });

  it("fails closed to undefined on non-serializable values such as BigInt", () => {
    expect(toJsonMetadataRecord({ n: 1n })).toBeUndefined();
  });

  it("fails closed to undefined when toJSON replaces the record root", () => {
    expect(toJsonMetadataRecord({ toJSON: () => 7 })).toBeUndefined();
    expect(toJsonMetadataRecord({ toJSON: () => null })).toBeUndefined();
    expect(toJsonMetadataRecord({ toJSON: () => [1, 2] })).toBeUndefined();
    expect(toJsonMetadataRecord({ toJSON: () => "scalar" })).toBeUndefined();
    expect(toJsonMetadataRecord({ toJSON: () => undefined })).toBeUndefined();
  });

  it("accepts toJSON replacements that remain plain records", () => {
    expect(toJsonMetadataRecord({ toJSON: () => ({ ok: true }) })).toEqual({ ok: true });
  });
});
