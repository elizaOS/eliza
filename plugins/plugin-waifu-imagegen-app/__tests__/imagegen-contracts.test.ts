import { describe, expect, it } from "vitest";
import {
  classifyImageGenStatus,
  type ImageGenError,
  imageGenMarkupPct,
  imageGenModelLabel,
  isImageGenError,
} from "../src/imagegen-contracts";

describe("classifyImageGenStatus", () => {
  it("maps each known HTTP status onto its typed error kind", () => {
    expect(classifyImageGenStatus(401, "x").kind).toBe("auth");
    expect(classifyImageGenStatus(402, "x").kind).toBe("insufficient-credits");
    expect(classifyImageGenStatus(404, "x").kind).toBe("not-available");
    expect(classifyImageGenStatus(409, "x").kind).toBe("duplicate");
    expect(classifyImageGenStatus(400, "x").kind).toBe("bad-request");
    expect(classifyImageGenStatus(503, "x").kind).toBe("misconfigured");
  });

  it("falls through to 'unknown' for unmapped statuses", () => {
    const e = classifyImageGenStatus(500, "boom");
    expect(e.kind).toBe("unknown");
    expect(e.status).toBe(500);
    expect(e.message).toBe("boom");
  });

  it("keeps the caller message for bad-request but uses a fixed copy for credits", () => {
    expect(classifyImageGenStatus(400, "prompt too short").message).toBe(
      "prompt too short",
    );
    // 402 ignores the upstream message in favor of user-facing copy.
    expect(classifyImageGenStatus(402, "raw upstream text").message).toBe(
      "not enough credits to generate",
    );
  });

  it("uses the fallback copy when bad-request/unknown messages are empty", () => {
    expect(classifyImageGenStatus(400, "").message).toBe("invalid request");
    expect(classifyImageGenStatus(599, "").message).toBe(
      "image generation failed",
    );
  });
});

describe("isImageGenError", () => {
  it("accepts a well-formed error and rejects other shapes", () => {
    const real: ImageGenError = { kind: "auth", status: 401, message: "x" };
    expect(isImageGenError(real)).toBe(true);
    expect(isImageGenError(null)).toBe(false);
    expect(isImageGenError({ status: 401 })).toBe(false);
    expect(isImageGenError({ kind: "auth" })).toBe(false);
    expect(isImageGenError(new Error("nope"))).toBe(false);
  });
});

describe("imageGenMarkupPct", () => {
  it("reads a numeric markup off the metadata bag", () => {
    expect(imageGenMarkupPct({ inferenceMarkupPercentage: 25 })).toBe(25);
    expect(imageGenMarkupPct({ inferenceMarkupPercentage: "12.5" })).toBe(12.5);
    expect(imageGenMarkupPct({ inferenceMarkupPercentage: 0 })).toBe(0);
  });

  it("returns null for missing, negative, or non-finite markup", () => {
    expect(imageGenMarkupPct(null)).toBeNull();
    expect(imageGenMarkupPct("not an object")).toBeNull();
    expect(imageGenMarkupPct({})).toBeNull();
    expect(imageGenMarkupPct({ inferenceMarkupPercentage: -5 })).toBeNull();
    expect(imageGenMarkupPct({ inferenceMarkupPercentage: "abc" })).toBeNull();
  });
});

describe("imageGenModelLabel", () => {
  it("returns a trimmed model label and null otherwise", () => {
    expect(imageGenModelLabel({ model: "  GPT Image 2 " })).toBe("GPT Image 2");
    expect(imageGenModelLabel({ model: "" })).toBeNull();
    expect(imageGenModelLabel({ model: 7 })).toBeNull();
    expect(imageGenModelLabel(null)).toBeNull();
  });
});
