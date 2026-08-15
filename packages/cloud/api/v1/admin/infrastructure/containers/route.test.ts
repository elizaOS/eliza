/**
 * Validates the admin infrastructure container-list query boundary without a database harness.
 */
import { describe, expect, test } from "bun:test";
import { parseContainerListLimit } from "./route";

describe("parseContainerListLimit", () => {
  test("defaults malformed and non-positive limits instead of forwarding invalid SQL limits", () => {
    expect(parseContainerListLimit("-1")).toBe(500);
    expect(parseContainerListLimit("25rows")).toBe(500);
    expect(parseContainerListLimit("0")).toBe(500);
  });

  test("preserves valid limits and caps oversized values", () => {
    expect(parseContainerListLimit("25")).toBe(25);
    expect(parseContainerListLimit(" 25 ")).toBe(25);
    expect(parseContainerListLimit("5000")).toBe(2000);
  });
});
