/**
 * Coverage for copy-feedback.
 */
import { describe, expect, it } from "vitest";
import { COPY_FEEDBACK_DURATION_MS } from "./copy-feedback.js";

describe("copy-feedback", () => {
  it("exposes duration", () => {
    expect(COPY_FEEDBACK_DURATION_MS).toBe(2000);
  });
});
