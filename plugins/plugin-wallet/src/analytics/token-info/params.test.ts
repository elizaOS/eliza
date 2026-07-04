/**
 * Token-info param parsing turns loose agent options + free text into a typed
 * query. Param readers coerce/trim and reject junk; subaction normalization
 * canonicalizes labels; and intent inference routes a message to the right
 * read-only lookup.
 */
import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  inferTokenInfoSubaction,
  normalizeTokenInfoSubaction,
  readBooleanParam,
  readNumberParam,
  readParams,
  readStringParam,
} from "./params.js";

const msg = (text: string): Memory =>
  ({ content: { text } }) as unknown as Memory;

describe("param readers", () => {
  it("readParams merges nested `parameters` over the top-level bag", () => {
    expect(readParams({ a: 1, parameters: { b: 2 } })).toMatchObject({
      a: 1,
      b: 2,
    });
    expect(readParams(undefined)).toEqual({});
  });

  it("readStringParam trims, scans keys, ignores empties", () => {
    expect(readStringParam({ q: "  hi " }, "q")).toBe("hi");
    expect(readStringParam({ q: "" }, "q")).toBeUndefined();
    expect(readStringParam({ parameters: { x: "yo" } }, "q", "x")).toBe("yo");
  });

  it("readNumberParam coerces, falls back; readBooleanParam reads keywords", () => {
    expect(readNumberParam({ n: 5 }, "n")).toBe(5);
    expect(readNumberParam({ n: "7" }, "n")).toBe(7);
    expect(readNumberParam({ n: "x" }, "n", 3)).toBe(3);
    expect(readBooleanParam({ b: "yes" }, "b")).toBe(true);
    expect(readBooleanParam({ b: "no" }, "b")).toBe(false);
    expect(readBooleanParam({ b: "maybe" }, "b")).toBeUndefined();
  });
});

describe("normalizeTokenInfoSubaction", () => {
  it("canonicalizes spacing/case to known subactions", () => {
    expect(normalizeTokenInfoSubaction("wallet")).toBe("wallet");
    expect(normalizeTokenInfoSubaction("New Pairs")).toBe("new_pairs");
    expect(normalizeTokenInfoSubaction("chain pairs")).toBe("chain_pairs");
    expect(normalizeTokenInfoSubaction(42)).toBeUndefined();
  });
});

describe("inferTokenInfoSubaction", () => {
  it("routes by message intent, defaults to token", () => {
    expect(inferTokenInfoSubaction(msg("show my wallet holdings"))).toBe(
      "wallet",
    );
    expect(inferTokenInfoSubaction(msg("what's trending right now"))).toBe(
      "trending",
    );
    expect(inferTokenInfoSubaction(msg("search for pepe"))).toBe("search");
    expect(inferTokenInfoSubaction(msg("tell me about this coin"))).toBe(
      "token",
    );
  });
});
