/**
 * Coverage for awareness.
 */
import { describe, expect, it } from "vitest";
import {
  SELF_STATUS_SCHEMA_VERSION,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_TOTAL_CHAR_LIMIT,
} from "./awareness.js";

describe("awareness", () => {
  it("exposes schema version", () => {
    expect(SELF_STATUS_SCHEMA_VERSION).toBe(1);
  });
  it("exposes limits", () => {
    expect(SUMMARY_CHAR_LIMIT).toBe(80);
    expect(SUMMARY_TOTAL_CHAR_LIMIT).toBe(1200);
  });
});
