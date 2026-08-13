/**
 * Unit tests for tweet timestamp normalization. Deterministic: no network,
 * no runtime. Covers seconds/ms/micros conversion, missing fallback, and
 * fail-closed handling of NaN / Infinity / negative values.
 */
import { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEpochMs, isInvalidTweetTimestamp, parseEpochMs } from "./time";

const UNIX_SECONDS = 1_710_969_600;
const UNIX_MILLIS = 1_710_969_600_000;
const UNIX_MICROS = 1_710_969_600_000_000;

describe("parseEpochMs", () => {
  it("converts Unix seconds (10 digits) to milliseconds", () => {
    expect(parseEpochMs(UNIX_SECONDS)).toBe(UNIX_MILLIS);
  });

  it("passes through millisecond timestamps (13 digits)", () => {
    expect(parseEpochMs(UNIX_MILLIS)).toBe(UNIX_MILLIS);
  });

  it("converts microsecond timestamps (16 digits) to milliseconds", () => {
    expect(parseEpochMs(UNIX_MICROS)).toBe(UNIX_MILLIS);
  });

  it("converts fractional Unix seconds", () => {
    expect(parseEpochMs(1_710_969_600.5)).toBe(1_710_969_600_500);
  });

  it("returns undefined for missing values", () => {
    expect(parseEpochMs(undefined)).toBeUndefined();
    expect(parseEpochMs(0)).toBeUndefined();
  });

  it("returns undefined for non-finite and negative values", () => {
    expect(parseEpochMs(Number.NaN)).toBeUndefined();
    expect(parseEpochMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseEpochMs(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(parseEpochMs(-1)).toBeUndefined();
  });
});

describe("isInvalidTweetTimestamp", () => {
  it("is false for missing timestamps", () => {
    expect(isInvalidTweetTimestamp(undefined)).toBe(false);
    expect(isInvalidTweetTimestamp(0)).toBe(false);
  });

  it("is false for usable seconds and milliseconds", () => {
    expect(isInvalidTweetTimestamp(UNIX_SECONDS)).toBe(false);
    expect(isInvalidTweetTimestamp(UNIX_MILLIS)).toBe(false);
  });

  it("is true for NaN, Infinity, and negatives", () => {
    expect(isInvalidTweetTimestamp(Number.NaN)).toBe(true);
    expect(isInvalidTweetTimestamp(Number.POSITIVE_INFINITY)).toBe(true);
    expect(isInvalidTweetTimestamp(-5)).toBe(true);
  });
});

describe("getEpochMs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to now for missing timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(UNIX_MILLIS);
    expect(getEpochMs(undefined)).toBe(UNIX_MILLIS);
    expect(getEpochMs(0)).toBe(UNIX_MILLIS);
  });

  it("normalizes seconds so they do not land as 1970-era millis", () => {
    expect(getEpochMs(UNIX_SECONDS)).toBe(UNIX_MILLIS);
  });

  it("throws ElizaError instead of substituting now for NaN", () => {
    expect(() => getEpochMs(Number.NaN)).toThrow(ElizaError);
    try {
      getEpochMs(Number.NaN);
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("X_INVALID_TWEET_TIMESTAMP");
    }
  });

  it("throws for Infinity and negatives", () => {
    expect(() => getEpochMs(Number.POSITIVE_INFINITY)).toThrow(ElizaError);
    expect(() => getEpochMs(-1)).toThrow(ElizaError);
  });

  it("does not make a NaN timestamp look like a just-posted tweet", () => {
    vi.useFakeTimers();
    vi.setSystemTime(UNIX_MILLIS);
    expect(isInvalidTweetTimestamp(Number.NaN)).toBe(true);
    expect(() => Date.now() - getEpochMs(Number.NaN)).toThrow(ElizaError);
  });
});
