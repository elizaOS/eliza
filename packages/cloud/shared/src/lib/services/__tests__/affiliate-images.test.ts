// Exercises affiliate images behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  buildAffiliateImageReferences,
  extractSafeImageUrls,
  hasValidReferenceImages,
} from "../affiliate-images";

// Affiliate image URLs are user-supplied and rendered, so the safety filter must
// drop non-http(s) schemes (javascript:/data:/file:) — a real SSRF/XSS boundary.
describe("affiliate-images URL safety", () => {
  test("extractSafeImageUrls keeps only http(s) string URLs", () => {
    expect(extractSafeImageUrls(undefined)).toEqual([]);
    expect(extractSafeImageUrls({ imageUrls: "not-an-array" })).toEqual([]);
    expect(
      extractSafeImageUrls({
        imageUrls: [
          "https://cdn.example.com/a.png",
          "http://example.com/b.jpg",
          "javascript:alert(1)",
          "data:image/png;base64,xxxx",
          "file:///etc/passwd",
          "/relative/path.png",
          123,
          null,
        ],
      }),
    ).toEqual(["https://cdn.example.com/a.png", "http://example.com/b.jpg"]);
  });

  test("hasValidReferenceImages reflects whether any safe URL remains", () => {
    expect(hasValidReferenceImages({ imageUrls: ["https://x.com/a.png"] })).toBe(true);
    expect(hasValidReferenceImages({ imageUrls: ["javascript:1", 5] })).toBe(false);
    expect(hasValidReferenceImages(undefined)).toBe(false);
  });

  test("buildAffiliateImageReferences marks the first url as the profile pic", () => {
    const refs = buildAffiliateImageReferences(["https://x.com/1.png", "https://x.com/2.png"]);
    expect(refs.map((r) => r.url)).toEqual(["https://x.com/1.png", "https://x.com/2.png"]);
    expect(refs.map((r) => r.isProfilePic)).toEqual([true, false]);
    expect(buildAffiliateImageReferences([])).toEqual([]);
  });
});
