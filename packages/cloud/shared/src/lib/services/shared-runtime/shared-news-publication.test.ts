import { describe, expect, test } from "bun:test";
import { publisherArticlePublication } from "./shared-news-publication";

const url = "https://example.com/story";
const title = "A public synthetic event happened";
const observedAt = Date.parse("2026-10-29T12:00:00Z");

function publication(dateLine: string) {
  const value = {
    url,
    title,
    excerpts: [`# ${title}\nPublished: ${dateLine}\n\nA public synthetic event happened today.`],
  };
  return publisherArticlePublication(value, url, title, "UTC", observedAt);
}

describe("publisher header month names", () => {
  test("control: Sep parses", () => {
    expect(publication("Sep 29, 2026")?.day).toBe("2026-09-29");
  });
  test("control: September parses", () => {
    expect(publication("September 29, 2026")?.day).toBe("2026-09-29");
  });
  test("control: Oct parses", () => {
    expect(publication("Oct 29, 2026")?.day).toBe("2026-10-29");
  });
  test("Sept parses to the same day", () => {
    expect(publication("Sept 29, 2026")?.day).toBe("2026-09-29");
  });
  test("Sept. (with period) parses to the same day", () => {
    expect(publication("Sept. 29, 2026")?.day).toBe("2026-09-29");
  });
  test("day-first 29 Sept 2026 parses to the same day", () => {
    expect(publication("29 Sept 2026")?.day).toBe("2026-09-29");
  });
  test("Sept with a zoned clock parses as an instant on that day", () => {
    const result = publication("Sept. 29, 2026 at 10:00 AM UTC");
    expect(result?.precision).toBe("instant");
    expect(result?.intrinsicDay).toBe("2026-09-29");
  });
  test("guard: Sept 31 stays rejected (not a real day)", () => {
    expect(publication("Sept 31, 2026")).toBeUndefined();
  });
});
