/**
 * Unit tests for useAudioElement: validates player hook export.
 */
import { describe, expect, it } from "vitest";
import { useAudioElement } from "./useAudioElement.ts";

describe("useAudioElement", () => {
  it("exports useAudioElement hook function", () => {
    expect(typeof useAudioElement).toBe("function");
  });
});
