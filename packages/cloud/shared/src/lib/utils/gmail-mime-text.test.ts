import { expect, test } from "bun:test";
import {
  decodeGmailPart,
  extractGmailBodyText,
  extractGmailHtmlLinks,
  gmailHasAttachmentsHint,
  gmailPartCharset,
  gmailSearchIncludesTrash,
  safeGmailLinkHref,
} from "./gmail-mime-text";

const part = (mimeType: string, text: string) => ({
  mimeType,
  body: { data: Buffer.from(text).toString("base64url"), size: text.length },
});

test("HTML-only message: anchors become inert links with plain-text labels", () => {
  const html = `<html><body><style>a{}</style><script>var a='<a href="https://script.invalid/">x</a>'</script>
    <p>Read <a class="btn" href="https://docs.example.org/plan?a=1&amp;b=2">the <b>plan</b></a>.</p>
    <a href='https://docs.example.org/plan?a=1&amp;b=2'>duplicate</a>
    <a href=https://unquoted.example.org/x>Unquoted</a>
    <a href="javascript:alert(1)">bad</a><a href="https://user:pw@example.org/">creds</a>
    <a href="mailto:someone@example.org">mail</a><a href="/relative">relative</a>
    <!-- <a href="https://comment.invalid/">hidden</a> -->
    <a href="http://plain.example.org/">  </a></body></html>`;
  const links = extractGmailHtmlLinks({
    mimeType: "text/html",
    body: part("text/html", html).body,
  });
  expect(links).toEqual([
    { href: "https://docs.example.org/plan?a=1&b=2", text: "the plan" },
    { href: "https://unquoted.example.org/x", text: "Unquoted" },
    { href: "http://plain.example.org/", text: "plain.example.org" },
  ]);
});

test("multipart/alternative: links come only from the HTML part; plain text yields none", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      part("text/plain", "Visit https://plain-only.example.org/ for details"),
      part("text/html", '<p>Visit <a href="https://html.example.org/">our site</a></p>'),
    ],
  };
  expect(extractGmailHtmlLinks(payload)).toEqual([
    { href: "https://html.example.org/", text: "our site" },
  ]);
  expect(extractGmailHtmlLinks(part("text/plain", "https://plain-only.example.org/"))).toEqual([]);
  expect(extractGmailHtmlLinks(null)).toEqual([]);
});

test("complete link lists retain every supported destination; malformed hrefs are dropped", () => {
  const many = Array.from(
    { length: 80 },
    (_, i) => `<a href="https://e.example.org/${i}">${i}</a>`,
  ).join("");
  expect(extractGmailHtmlLinks(part("text/html", many))).toHaveLength(80);
  expect(safeGmailLinkHref(`https://example.org/${"a".repeat(2100)}`)).toBeNull();
  expect(safeGmailLinkHref("https://")).toBeNull();
  expect(safeGmailLinkHref("data:text/html,x")).toBeNull();
});

test("only a real href attribute counts: data-href and quoted text are ignored", () => {
  const html = `<a data-href="https://data.invalid/" title='href="https://title.invalid/"' HREF = "https://real.example.org/">Real</a>
    <a href=https://eq.example.org/?a=b&amp;c=d>Query</a><a title="unclosed href="https://x.invalid/>none</a>`;
  expect(extractGmailHtmlLinks(part("text/html", html))).toEqual([
    { href: "https://real.example.org/", text: "Real" },
    { href: "https://eq.example.org/?a=b&c=d", text: "Query" },
  ]);
});

test("hostile markup is scanned in linear time", () => {
  const hostile = [
    "<a x>".repeat(200_000),
    "<!--".repeat(200_000),
    "<script>".repeat(200_000),
    `<a href="${"<".repeat(400_000)}">x</a>`,
    `<a title="${'href="'.repeat(100_000)}">x</a>`,
  ];
  for (const html of hostile) {
    const started = performance.now();
    extractGmailHtmlLinks(part("text/html", `<a href="https://first.example.org/">ok</a>${html}`));
    // Quadratic scanning of these inputs takes minutes; the linear scan takes milliseconds.
    expect(performance.now() - started).toBeLessThan(5_000);
  }
});

const encoded = (bytes: number[], contentType?: string, mimeType = "text/plain") => ({
  mimeType,
  ...(contentType ? { headers: [{ name: "Content-Type", value: contentType }] } : {}),
  body: { data: Buffer.from(bytes).toString("base64url") },
});

test("0056: ISO-8859-1 text part decodes with its declared charset", () => {
  const latin1 = [
    ...Buffer.from("Caf"),
    0xe9,
    0x20,
    0xe0,
    0x20,
    ...Buffer.from("cr"),
    0xe8,
    ...Buffer.from("me"),
  ];
  const part = encoded(latin1, 'text/plain; charset="ISO-8859-1"');
  expect(gmailPartCharset(part)).toBe("iso-8859-1");
  expect(decodeGmailPart(part)).toBe("Café à crème");
  expect(extractGmailBodyText({ mimeType: "multipart/alternative", parts: [part] })).toBe(
    "Café à crème",
  );
  // Without the charset the same bytes are invalid UTF-8 and become replacement characters.
  expect(decodeGmailPart(encoded(latin1))).toContain("�");
});

test("0056: Windows-1252 smart quotes, dash and euro decode exactly", () => {
  const cp1252 = [
    0x93,
    ...Buffer.from("Quote"),
    0x94,
    0x20,
    0x96,
    0x20,
    0x80,
    ...Buffer.from("5"),
    0x85,
  ];
  const part = encoded(cp1252, "text/plain; charset=windows-1252; format=flowed");
  expect(gmailPartCharset(part)).toBe("windows-1252");
  expect(decodeGmailPart(part)).toBe("“Quote” – €5…");
});

test("0056: HTML part charset applies to links; unknown charsets fall back to UTF-8", () => {
  const html = [...Buffer.from('<a href="https://example.org/">Men'), 0xfa, ...Buffer.from("</a>")];
  expect(
    extractGmailHtmlLinks(encoded(html, "text/html; charset=iso-8859-1", "text/html")),
  ).toEqual([{ href: "https://example.org/", text: "Menú" }]);
  const utf8 = [...Buffer.from("Menú ✓")];
  expect(decodeGmailPart(encoded(utf8, "text/plain; charset=x-unknown-charset"))).toBe("Menú ✓");
  expect(decodeGmailPart(encoded(utf8, "text/plain; charset=UTF-8"))).toBe("Menú ✓");
  expect(decodeGmailPart(encoded(utf8))).toBe("Menú ✓");
});

test("0057: search attachment hint from metadata and full payloads; explicit in:trash only", () => {
  expect(gmailHasAttachmentsHint({ mimeType: "multipart/mixed", headers: [] })).toBe(true);
  expect(gmailHasAttachmentsHint({ mimeType: "multipart/alternative", headers: [] })).toBe(false);
  expect(gmailHasAttachmentsHint({ mimeType: "text/plain" })).toBe(false);
  expect(
    gmailHasAttachmentsHint({
      mimeType: "multipart/related",
      parts: [{ mimeType: "text/html" }, { mimeType: "application/pdf", filename: "a.pdf" }],
    }),
  ).toBe(true);
  expect(gmailHasAttachmentsHint(null)).toBe(false);
  // The read path walks the same payload as the attachment walker, so it shares its part budget.
  const large = {
    mimeType: "multipart/related",
    parts: [
      part("text/html", '<a href="https://example.org/a">A</a>'),
      ...Array.from({ length: 300 }, () => ({ mimeType: "image/png", filename: "i.png" })),
    ],
  };
  expect(gmailHasAttachmentsHint(large)).toBe(true);
  expect(extractGmailHtmlLinks(large)).toEqual([{ href: "https://example.org/a", text: "A" }]);
  expect(gmailSearchIncludesTrash("in:trash")).toBe(true);
  expect(gmailSearchIncludesTrash("from:a@example.org IN:TRASH")).toBe(true);
  expect(gmailSearchIncludesTrash("in:inbox")).toBe(false);
  expect(gmailSearchIncludesTrash("subject:in:trashcan")).toBe(false);
  expect(gmailSearchIncludesTrash(undefined)).toBe(false);
});
