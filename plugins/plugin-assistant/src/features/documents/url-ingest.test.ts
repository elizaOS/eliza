/**
 * Covers numeric HTML-entity decoding in the URL-import plain-text path.
 * Reviewer request on #34465: assert hex (&#x27;), decimal (&#8217;), and an
 * out-of-range reference that must pass through unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: "93.184.216.34", family: 4 })),
}));

import {
  __setDocumentUrlFetchImplForTests,
  fetchDocumentFromUrl,
} from "./url-ingest.ts";

beforeEach(() => {
  __setDocumentUrlFetchImplForTests(
    async () =>
      new Response(
        "<html><body><p>It&#x27;s &#8217;snowing&#8217; &#8211; end. Keep &#0; and &#xD800; and &#1114112;.</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
  );
});

afterEach(() => {
  __setDocumentUrlFetchImplForTests(null);
});

describe("url-ingest numeric HTML entities", () => {
  it("decodes hex and decimal references and leaves out-of-range refs intact", async () => {
    const doc = await fetchDocumentFromUrl(
      "https://example.com/entity-check.html",
    );
    expect(doc.contentType).toBe("html");
    expect(doc.content).toContain("It's");
    expect(doc.content).toContain("\u2019snowing\u2019");
    expect(doc.content).toContain("\u2013 end");
    expect(doc.content).toContain("&#0;");
    expect(doc.content).toContain("&#xD800;");
    expect(doc.content).toContain("&#1114112;");
    expect(doc.content).not.toContain("&#x27;");
    expect(doc.content).not.toContain("&#8217;");
  });
});

describe("url-ingest response charset", () => {
  it("decodes the body with the Content-Type charset", async () => {
    const pages: Array<[string, number[], string]> = [
      // "Café crème" in ISO-8859-1
      [
        "text/html; charset=ISO-8859-1",
        [0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65],
        "Café crème",
      ],
      // "日本語" in Shift_JIS
      [
        "text/plain; charset=Shift_JIS",
        [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea],
        "日本語",
      ],
    ];
    for (const [contentType, bytes, expected] of pages) {
      __setDocumentUrlFetchImplForTests(
        async () =>
          new Response(Uint8Array.from(bytes), {
            status: 200,
            headers: { "content-type": contentType },
          }),
      );
      const doc = await fetchDocumentFromUrl("https://example.com/page");
      expect(doc.content.trim()).toBe(expected);
    }
  });
});
