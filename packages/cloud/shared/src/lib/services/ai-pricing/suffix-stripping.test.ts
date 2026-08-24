/**
 * Behavioral coverage for versioned-snapshot suffix stripping of model ids.
 *
 * The contract: dated (`-2024-06-05`, `-20240605`), labelled (`-latest`,
 * `-preview`, `-beta`) and numeric (`-001`) suffixes are stripped from model
 * ids so pricing lookup under the canonical unsuffixed id succeeds. Numeric
 * suffixes require at least two dash-separated segments to remain after the
 * provider slash so `openai/gpt-4` never collapses to `openai/gpt`.
 */
import { describe, expect, test } from "bun:test";
import { stripVersionedSnapshotSuffix } from "./suffix-stripping";

describe("stripVersionedSnapshotSuffix", () => {
  test("strips ISO-date suffixes", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-2024-11-20")).toBe(
      "openai/gpt-4o",
    );
    expect(stripVersionedSnapshotSuffix("openai/o1-2024-12-17")).toBe(
      "openai/o1",
    );
  });

  test("strips compact dated suffixes (year-anchored)", () => {
    expect(stripVersionedSnapshotSuffix("google/gemini-2.0-flash-20240605")).toBe(
      "google/gemini-2.0-flash",
    );
  });

  test("does not strip unrelated 8-digit run ids", () => {
    expect(stripVersionedSnapshotSuffix("anthropic/claude-12345678")).toBeNull();
  });

  test("strips labelled suffixes", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-latest")).toBe("openai/gpt-4o");
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-preview")).toBe("openai/gpt-4o");
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-beta")).toBe("openai/gpt-4o");
  });

  test("strips numeric suffixes when enough segments remain", () => {
    expect(stripVersionedSnapshotSuffix("google/gemini-2.0-flash-001")).toBe(
      "google/gemini-2.0-flash",
    );
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-1234")).toBe("openai/gpt-4o");
  });

  test("refuses to collapse a provider to a bare name (numeric safety rail)", () => {
    // After stripping "-4", only one dash segment ("gpt") would remain.
    expect(stripVersionedSnapshotSuffix("openai/gpt-4")).toBeNull();
  });

  test("returns null when no rule applies", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o")).toBeNull();
    expect(stripVersionedSnapshotSuffix("deepseek/deepseek-chat")).toBeNull();
  });

  test("returns null for degenerate results", () => {
    expect(stripVersionedSnapshotSuffix("-latest")).toBeNull();
    expect(stripVersionedSnapshotSuffix("provider/-001")).toBeNull();
    expect(stripVersionedSnapshotSuffix("-2024-06-05")).toBeNull();
  });

  test("is case-sensitive like the catalog entries it matches", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-Latest")).toBeNull();
  });
});
