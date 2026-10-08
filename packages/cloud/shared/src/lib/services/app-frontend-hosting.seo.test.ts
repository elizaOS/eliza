import { describe, expect, test } from "bun:test";
import { injectSeo } from "./app-frontend-hosting";

describe("injectSeo", () => {
  test("keeps a single-quoted description instead of adding a second one", () => {
    const html = injectSeo(
      "<html><head><meta name='description' content='Keep me'></head><body></body></html>",
      { description: "Other" },
    );
    expect(html.match(/\bname\s*=\s*["']description["']/gi)?.length ?? 0).toBe(1);
    expect(html).toContain("Keep me");
  });
});
