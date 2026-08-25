/** Validates the closed configuration boundary for graduated memory-horizon runs. */

import { describe, expect, it } from "vitest";
import {
  MEMORY_HORIZON_SIZES,
  memoryHorizonCorpusShape,
  parseMemoryHorizonSize,
} from "./memory-horizon";

describe("memory horizon configuration", () => {
  it.each(MEMORY_HORIZON_SIZES)(
    "accepts the supported %i-message tier",
    (size) => {
      expect(parseMemoryHorizonSize(String(size))).toEqual({
        kind: "valid",
        size,
      });
      expect(memoryHorizonCorpusShape(size)).toEqual({
        conversationCount: 10,
        messagesPerConversation: size / 10,
      });
    },
  );

  it.each(["499", "1001", "5.5", "many", "-1000"])(
    "rejects unsupported input %s",
    (value) => {
      expect(parseMemoryHorizonSize(value).kind).toBe("invalid");
    },
  );

  it("defaults to the first graduated tier", () => {
    expect(parseMemoryHorizonSize(undefined)).toEqual({
      kind: "valid",
      size: 500,
    });
  });
});
