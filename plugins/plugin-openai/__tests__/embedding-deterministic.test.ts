import { describe, expect, it } from "vitest";
import { createDeterministicEmbedding } from "../models/embedding";

describe("createDeterministicEmbedding surrogate safety", () => {
  it("generates normalized embedding vectors for long emoji inputs without surrogate bisection", () => {
    // "🔥" (2 code units * 300 = 600 units) -> > 512
    const longEmojiText = "🔥".repeat(300);
    const vec = createDeterministicEmbedding(longEmojiText, 384);

    expect(vec).toHaveLength(384);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });
});
