import { describe, expect, it } from "vitest";
import { extractUrls } from "./extract-urls";

describe("extractUrls", () => {
  it("keeps bracket pairs and apostrophes inside a URL", () => {
    expect(
      extractUrls(
        "Open https://api.example.com/items?filter[status]=open&page[size]=10",
      ),
    ).toEqual([
      "https://api.example.com/items?filter[status]=open&page[size]=10",
    ]);
    expect(extractUrls("Ingest https://example.com/docs/a[1]/b.pdf")).toEqual([
      "https://example.com/docs/a[1]/b.pdf",
    ]);
    expect(
      extractUrls("Read https://en.wikipedia.org/wiki/Schindler's_List please"),
    ).toEqual(["https://en.wikipedia.org/wiki/Schindler's_List"]);
  });

  it("still ends a URL at an unmatched bracket or a closing quote", () => {
    expect(
      extractUrls("See [https://a.example/x](https://b.example/y)"),
    ).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(extractUrls("Quoted 'https://example.com/a' here")).toEqual([
      "https://example.com/a",
    ]);
    expect(extractUrls("Local http://[::1]:8080/path ok")).toEqual([
      "http://[::1]:8080/path",
    ]);
  });
});
