import { describe, expect, it } from "vitest";
import {
  authoredBrowserDestination,
  browserDestinationMatches,
} from "./browser-request-grounding.ts";

describe("explicit current browser destination", () => {
  it.each([
    ["example.com/dashboard", "https://example.com/dashboard"],
    ["https://EXAMPLE.com/a?q=1#section", "https://example.com/a?q=1#section"],
    ["open example.com/dashboard", "https://example.com/dashboard"],
    [
      'Please visit "https://example.com/a?q=1#section"',
      "https://example.com/a?q=1#section",
    ],
    ["go to example.com", "https://example.com/"],
    ["Open example.com.", "https://example.com/"],
    ["Open example.com!", "https://example.com/"],
    ["Open https://example.com/path.", "https://example.com/path."],
    [
      "Open https://example.com/?q=O'Reilly",
      "https://example.com/?q=O%27Reilly",
    ],
    ["navigate to 'example.com/path'", "https://example.com/path"],
  ])("accepts exact target %s", (text, href) =>
    expect(authoredBrowserDestination(text)).toBe(href),
  );
  it.each([
    "make another one for breakfast at 11 am",
    "What's the weather?",
    "don't open example.com",
    "do not visit example.com",
    "never open example.com",
    '"https://example.com"',
    'Explain "open example.com"',
    "The page says open example.com",
    "Summarize https://example.com",
    "open example.com and read its title",
    "if it rains open example.com",
    "open LinkedIn",
    "open person@example.com",
    "https://person:secret@example.com/",
    "open javascript:alert(1)",
    "open http://example.com",
    "open example..com",
    "open https://example.com\\@evil.com",
    "open https://example.com\n",
  ])("does not derive navigation authority from %s", (text) =>
    expect(authoredBrowserDestination(text)).toBeUndefined(),
  );
  it("compares the entire normalized destination", () => {
    const href = authoredBrowserDestination(
      "open https://example.com/a?q=1#one",
    );
    expect(
      browserDestinationMatches(
        { type: "browser_navigate", url: "https://EXAMPLE.com/a?q=1#one" },
        href,
      ),
    ).toBe(true);
    for (const url of [
      "https://example.com/b?q=1#one",
      "https://example.com/a?q=2#one",
      "https://example.com/a?q=1#two",
      "https://evil.com/a?q=1#one",
    ])
      expect(
        browserDestinationMatches({ type: "browser_navigate", url }, href),
      ).toBe(false);
    expect(
      browserDestinationMatches({ type: "open_view", url: href }, href),
    ).toBe(false);
  });
});
