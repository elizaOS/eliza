/**
 * Coverage for image-generation.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGE_SIZE_MB,
  MIN_IMAGE_INTERVAL_MS,
} from "./image-generation.js";

describe("image-generation", () => {
  it("exposes size limits", () => {
    expect(MAX_IMAGE_SIZE_MB).toBe(10);
    expect(MAX_IMAGE_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });
  it("exposes interval", () => {
    expect(MIN_IMAGE_INTERVAL_MS).toBe(60 * 1000);
  });
});
