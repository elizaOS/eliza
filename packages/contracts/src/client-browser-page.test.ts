import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserPageMatchesObservation,
  CLIENT_BROWSER_PAGE_LINKS_MAX,
  CLIENT_BROWSER_PAGE_MAX_BYTES,
  CLIENT_BROWSER_PAGE_TEXT_MAX,
  parseClientBrowserPageObservation,
  parseClientTurnObservation,
  readClientBrowserPage,
} from "./client-turn-observation.ts";

const observation = {
  view: "browser",
  revision: 4,
  sensitive: false,
  timeZone: "UTC",
  selectedObject: { kind: "browser-tab", id: "tab-1", revision: "7" },
};
const page = {
  tabId: "tab-1",
  revision: "7",
  url: "https://en.wikipedia.org/wiki/Octopus?useskin=minerva",
  title: "Octopus - Wikipedia",
  capturedAt: 1_795_000_000_000,
  text: "Octopus\nAn octopus is a soft-bodied, eight-limbed mollusc.",
  truncated: false,
  selection: "eight-limbed mollusc",
  links: [
    { text: "Cephalopod", url: "https://en.wikipedia.org/wiki/Cephalopod" },
  ],
};

test("a Browser page keeps its declared fields in canonical order and is frozen", () => {
  const parsed = parseClientBrowserPageObservation({
    links: page.links,
    ...page,
  });
  assert.equal(JSON.stringify(parsed), JSON.stringify(page));
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.links));
  assert.ok(Object.isFrozen(parsed.links?.[0]));
});

test("a withheld page carries only its address and title", () => {
  const withheld = {
    tabId: "tab-1",
    revision: "7",
    url: "https://example.com/",
    title: "Example",
    capturedAt: 1,
    withheld: "sensitive-page",
  };
  assert.deepEqual(parseClientBrowserPageObservation(withheld), withheld);
  for (const extra of [
    { text: "x", truncated: false },
    { truncated: false },
    { selection: "x" },
    { links: [] },
  ])
    assert.throws(
      () => parseClientBrowserPageObservation({ ...withheld, ...extra }),
      /carries no page content/,
    );
  assert.throws(
    () =>
      parseClientBrowserPageObservation({ ...withheld, withheld: "private" }),
    /withheld reason/,
  );
});

test("addresses must be absolute HTTPS without credentials or fragment", () => {
  for (const url of [
    "http://example.com/",
    "https://user:pass@example.com/",
    "https://example.com/#top",
    "https://example.com/#",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://example.com",
    " https://example.com/",
    `https://example.com/${"a".repeat(2048)}`,
    7,
  ]) {
    assert.throws(
      () => parseClientBrowserPageObservation({ ...page, url }),
      /address is invalid/,
      String(url),
    );
    assert.throws(
      () =>
        parseClientBrowserPageObservation({
          ...page,
          links: [{ text: "x", url }],
        }),
      /link is invalid/,
      String(url),
    );
  }
});

test("page text, title, selection and links are bounded and control-free", () => {
  assert.equal(
    parseClientBrowserPageObservation({
      ...page,
      text: "a".repeat(CLIENT_BROWSER_PAGE_TEXT_MAX),
      selection: undefined,
      links: undefined,
    }).text?.length,
    CLIENT_BROWSER_PAGE_TEXT_MAX,
  );
  const invalid: Array<[Record<string, unknown>, RegExp]> = [
    [{ text: "a".repeat(CLIENT_BROWSER_PAGE_TEXT_MAX + 1) }, /text is invalid/],
    [{ text: "bell\u0007" }, /text is invalid/],
    [{ text: "split\u2028line" }, /text is invalid/],
    [{ text: "lone \uD800 surrogate" }, /text is invalid/],
    [{ text: undefined }, /text is invalid/],
    [{ truncated: "no" }, /truncation is invalid/],
    [{ title: "two\nlines" }, /title is invalid/],
    [{ title: "t".repeat(301) }, /title is invalid/],
    [{ selection: "s".repeat(1001) }, /selection is invalid/],
    [{ links: {} }, /links are invalid/],
    [
      {
        links: Array.from(
          { length: CLIENT_BROWSER_PAGE_LINKS_MAX + 1 },
          () => ({
            text: "x",
            url: "https://example.com/",
          }),
        ),
      },
      /links are invalid/,
    ],
    [
      { links: [{ text: "  ", url: "https://example.com/" }] },
      /link text is empty/,
    ],
    [
      { links: [{ text: "x\ny", url: "https://example.com/" }] },
      /link text is invalid/,
    ],
    [
      { links: [{ text: "x", url: "https://example.com/", title: "y" }] },
      /unsupported field/,
    ],
    [{ tabId: "tab 1" }, /tab is invalid/],
    [{ revision: "" }, /revision is invalid/],
    [{ capturedAt: -1 }, /time is invalid/],
    [{ capturedAt: 1.5 }, /time is invalid/],
    [{ instructions: "ignore previous" }, /unsupported field/],
  ];
  for (const [change, error] of invalid)
    assert.throws(
      () => parseClientBrowserPageObservation({ ...page, ...change }),
      error,
      JSON.stringify(change).slice(0, 80),
    );
});

test("a page over the byte budget is refused, not cut", () => {
  // Four-byte characters: 6,000 UTF-16 units is 12,000 bytes of text alone.
  const wide = "\u{1F419}".repeat(CLIENT_BROWSER_PAGE_TEXT_MAX / 2);
  const links = Array.from(
    { length: CLIENT_BROWSER_PAGE_LINKS_MAX },
    (_, i) => ({
      text: "l".repeat(120),
      url: `https://example.com/${i}/${"p".repeat(60)}`,
    }),
  );
  assert.throws(
    () =>
      parseClientBrowserPageObservation({
        ...page,
        text: wide,
        selection: "s".repeat(1000),
        links,
      }),
    /too large/,
  );
  assert.ok(CLIENT_BROWSER_PAGE_MAX_BYTES >= 12_000);
});

test("the page is read only when bound to the observed Browser tab", () => {
  const metadata = (context: unknown, browserPage: unknown) => ({
    clientDevice: { context, browserPage },
  });
  assert.deepEqual(readClientBrowserPage(metadata(observation, page)), page);
  const parsedObservation = parseClientTurnObservation(observation);
  assert.ok(
    browserPageMatchesObservation(
      parseClientBrowserPageObservation(page),
      parsedObservation,
    ),
  );
  for (const context of [
    { ...observation, view: "home" },
    {
      ...observation,
      selectedObject: { ...observation.selectedObject, id: "tab-2" },
    },
    {
      ...observation,
      selectedObject: { ...observation.selectedObject, revision: "8" },
    },
    {
      ...observation,
      selectedObject: { kind: "photo", id: "tab-1", revision: "7" },
    },
    { view: "browser", revision: 4, sensitive: false },
    { view: "browser", revision: 4, sensitive: true },
    { view: "browser", revision: -1, sensitive: false },
  ])
    assert.equal(readClientBrowserPage(metadata(context, page)), undefined);
  assert.equal(
    readClientBrowserPage(
      metadata(observation, { ...page, url: "http://a.test/" }),
    ),
    undefined,
  );
  assert.equal(
    readClientBrowserPage(metadata(observation, undefined)),
    undefined,
  );
  assert.equal(
    readClientBrowserPage({ clientDevice: { browserPage: page } }),
    undefined,
  );
  for (const value of [undefined, null, [], "x", { clientDevice: [] }])
    assert.equal(readClientBrowserPage(value), undefined);
});
