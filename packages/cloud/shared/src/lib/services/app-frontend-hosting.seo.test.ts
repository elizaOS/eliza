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

test("quoted content and ordinary element attributes do not suppress metadata", () => {
  for (const misleading of [
    "<meta content=\"Text name='description'\">",
    "<input name='description'>",
    "<!-- <meta name='description'> -->",
    "<script>const example = \" name='description'\";</script>",
  ]) {
    const result = injectSeo(`<html><head>${misleading}</head><body></body></html>`, {
      description: "Required metadata",
    });
    expect(result).toContain('<meta name="description" content="Required metadata" />');
  }
});
test("preserves all declared metadata and canonical links across quote styles", () => {
  const html = `<html><head><title>Keep</title><meta NAME = 'description' content='Keep'><meta property='og:title' content='Keep'><meta property='og:description' content='Keep'><meta property='og:image' content='Keep'><meta property='og:url' content='Keep'><meta property='og:site_name' content='Keep'><meta name='twitter:card' content='Keep'><link rel='canonical' href='Keep'></head></html>`;
  expect(
    injectSeo(html, {
      title: "Other",
      description: "Other",
      image: "Other",
      url: "Other",
      siteName: "Other",
    }),
  ).toBe(html);
});
