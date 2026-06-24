import { describe, expect, it } from "bun:test";
import {
  isFiniteNumber,
  isObject,
  isString,
  isValidDate,
  isValidEventType,
  isValidMarketType,
  isValidPointsToward,
  isValidQuestionStatus,
  isValidTradeAction,
  isValidVisibility,
} from "../../engine/src/types/guards";

/**
 * Engine runtime type guards. These validate untrusted world-event / trade /
 * market data at the boundary. isObject in particular enforces plain-object
 * semantics (rejects arrays + non-Object prototypes) — a guard against
 * prototype-pollution-shaped payloads.
 */

describe("enum guards", () => {
  it("accept members, reject non-members", () => {
    expect(isValidEventType("announcement")).toBe(true);
    expect(isValidEventType("bogus")).toBe(false);
    expect(isValidVisibility("secret")).toBe(true);
    expect(isValidVisibility("nope")).toBe(false);
    expect(isValidMarketType("perp")).toBe(true);
    expect(isValidMarketType("spot")).toBe(false);
    expect(isValidTradeAction("buy_yes")).toBe(true);
    expect(isValidTradeAction("rug")).toBe(false);
    expect(isValidQuestionStatus("resolved")).toBe(true);
    expect(isValidQuestionStatus("???")).toBe(false);
  });

  it("isValidPointsToward allows null / YES / NO only", () => {
    expect(isValidPointsToward(null)).toBe(true);
    expect(isValidPointsToward("YES")).toBe(true);
    expect(isValidPointsToward("NO")).toBe(true);
    expect(isValidPointsToward("MAYBE")).toBe(false);
  });
});

describe("primitive guards", () => {
  it("isObject enforces plain-object semantics", () => {
    expect(isObject({})).toBe(true);
    expect(isObject(Object.create(null))).toBe(true); // null prototype ok
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject("x")).toBe(false);
    // Non-plain prototype is rejected (pollution-shaped payload).
    expect(isObject(Object.create({ polluted: true }))).toBe(false);
  });

  it("isString / isFiniteNumber / isValidDate", () => {
    expect(isString("a")).toBe(true);
    expect(isString(1)).toBe(false);
    expect(isFiniteNumber(1.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidDate(new Date("2026-06-23"))).toBe(true);
    expect(isValidDate(new Date("invalid"))).toBe(false);
    expect(isValidDate("2026-06-23")).toBe(false);
  });
});
