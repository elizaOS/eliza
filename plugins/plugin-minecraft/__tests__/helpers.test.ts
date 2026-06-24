import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  callbackContent,
  capMinecraftData,
  isPlaceFace,
  isRecord,
  mergedInput,
  parseJsonObject,
  parseVec3,
  readBoolean,
  readNumber,
  readParams,
  readString,
} from "../src/actions/helpers.js";

/**
 * MC action input helpers. They merge free-text JSON with structured params and
 * coerce/validate fields before they reach the Mineflayer bridge — robust
 * parsing here keeps a malformed agent message from crashing a bot op.
 */

const msg = (text: string): Memory => ({ content: { text } }) as unknown as Memory;

describe("isRecord / parseJsonObject", () => {
  it("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  it("parseJsonObject only parses brace-delimited JSON objects", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('  {"x":2}  ')).toEqual({ x: 2 });
    expect(parseJsonObject("not json")).toEqual({});
    expect(parseJsonObject("[1,2]")).toEqual({});
    expect(parseJsonObject("{bad}")).toEqual({});
  });
});

describe("readParams / mergedInput", () => {
  it("readParams returns the nested parameters bag or {}", () => {
    expect(readParams({ parameters: { a: 1 } })).toEqual({ a: 1 });
    expect(readParams({})).toEqual({});
    expect(readParams(undefined)).toEqual({});
  });

  it("mergedInput overlays structured params over free-text JSON", () => {
    expect(mergedInput(msg('{"x":1}'), { parameters: { y: 2 } })).toEqual({
      x: 1,
      y: 2,
    });
    // params win on conflict.
    expect(mergedInput(msg('{"x":1}'), { parameters: { x: 9 } })).toEqual({
      x: 9,
    });
  });
});

describe("typed readers", () => {
  it("readString trims, skips empties, scans keys in order", () => {
    expect(readString({ a: "  hi " }, "a")).toBe("hi");
    expect(readString({ a: "" }, "a")).toBeNull();
    expect(readString({ a: 1 }, "a")).toBeNull();
    expect(readString({ b: "yo" }, "a", "b")).toBe("yo");
  });

  it("readNumber accepts numbers and numeric strings, rejects non-finite", () => {
    expect(readNumber({ a: 5 }, "a")).toBe(5);
    expect(readNumber({ a: "7" }, "a")).toBe(7);
    expect(readNumber({ a: "x" }, "a")).toBeNull();
    expect(readNumber({ a: Number.POSITIVE_INFINITY }, "a")).toBeNull();
  });

  it("readBoolean accepts bools and true/false strings", () => {
    expect(readBoolean({ a: true }, "a")).toBe(true);
    expect(readBoolean({ a: "FALSE" }, "a")).toBe(false);
    expect(readBoolean({ a: "maybe" }, "a")).toBeNull();
    expect(readBoolean({ a: 1 }, "a")).toBeNull();
  });
});

describe("parseVec3 / isPlaceFace", () => {
  it("parseVec3 builds a vec from explicit x/y/z params", () => {
    expect(parseVec3({ x: 1, y: 2, z: 3 }, "")).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("isPlaceFace gates the six block faces", () => {
    expect(isPlaceFace("up")).toBe(true);
    expect(isPlaceFace("north")).toBe(true);
    expect(isPlaceFace("sideways")).toBe(false);
    expect(isPlaceFace(null)).toBe(false);
  });
});

describe("callbackContent / capMinecraftData", () => {
  it("callbackContent stamps the action and a string source only", () => {
    expect(callbackContent("MC", "hi", "client")).toEqual({
      text: "hi",
      actions: ["MC"],
      source: "client",
    });
    expect(callbackContent("MC", "hi", 42).source).toBeUndefined();
  });

  it("capMinecraftData caps arrays at 25 items, passes other values through", () => {
    expect(capMinecraftData(Array.from({ length: 30 }, (_, i) => i))).toHaveLength(25);
    expect(capMinecraftData({ a: 1 })).toEqual({ a: 1 });
  });
});
