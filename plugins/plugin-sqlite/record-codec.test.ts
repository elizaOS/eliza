/** Verifies portable value fidelity and explicit rejection of corrupt or unsupported records. */
import { expect, it } from "vitest";
import { decodeRecord, encodeRecord } from "./record-codec";

it("preserves complete cyclic values, collection identity and binary types", () => {
  const shared = { text: "complete context ".repeat(9000) };
  const value: Record<string, unknown> = {
    shared,
    again: shared,
    date: new Date("2026-09-23T00:00:00Z"),
    big: 2n ** 100n,
    missing: undefined,
    zero: -0,
    infinity: Infinity,
    nan: NaN,
    // biome-ignore lint/suspicious/noSparseArray: Persisted holes must remain distinct from explicit undefined.
    sparse: [1, , undefined],
    map: new Map([[shared, shared]]),
    set: new Set([shared]),
    bytes: Buffer.from([0, 1, 255]),
    typed: new Float64Array([1.25, -2.5]),
  };
  value.self = value;
  expect(decodeRecord(encodeRecord(value))).toStrictEqual(value);
});

it("rejects unsupported values instead of silently deleting them", () => {
  expect(() => encodeRecord({ callback: () => true })).toThrow(
    expect.objectContaining({ code: "SQLITE_RECORD_ENCODING_UNSUPPORTED" }),
  );
});

it("rejects unknown formats and damaged complete payloads", () => {
  expect(() => decodeRecord(Buffer.from("unrecognized"))).toThrow(
    expect.objectContaining({ code: "SQLITE_RECORD_CODEC_UNSUPPORTED" }),
  );
  const damaged = encodeRecord({ complete: "value" });
  damaged[damaged.length - 1] = 0;
  expect(() => decodeRecord(damaged)).toThrow(
    expect.objectContaining({ code: "SQLITE_RECORD_INVALID" }),
  );
});

it("rejects malformed UTF-8 rather than replacing bytes inside otherwise valid JSON", () => {
  const encoded = Buffer.from(encodeRecord("visible-marker"));
  encoded[encoded.indexOf("visible-marker")] = 255;
  expect(() => decodeRecord(encoded)).toThrow(
    expect.objectContaining({ code: "SQLITE_RECORD_INVALID" }),
  );
});
