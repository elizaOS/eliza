import { expect, test } from "bun:test";
import { readGmailMetadataBatch } from "./gmail-metadata-batch";
import { extractGmailHtmlView, gmailSearchIncludesTrash } from "./gmail-mime-text";

const response = (rows: { index: number; id: string; status?: number }[]) =>
  new Response(
    rows
      .map(
        (r) =>
          `--batch_owned\r\nContent-Type: application/http\r\nContent-ID: <response-alpha-${r.index}>\r\n\r\nHTTP/1.1 ${r.status ?? 200} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ id: r.id, threadId: "thread" })}\r\n`,
      )
      .join("") + "--batch_owned--\r\n",
    { headers: { "Content-Type": "multipart/mixed; boundary=batch_owned" } },
  );
test("one ordered metadata HTTP exchange; requests contain only paths and stable IDs", async () => {
  let calls = 0;
  const rows = await readGmailMetadataBatch(
    ["one", "two"],
    ["From", "Subject"],
    async (url, options) => {
      calls++;
      expect(url).toBe("https://gmail.googleapis.com/batch");
      expect(options.method).toBe("POST");
      expect(String(options.body)).toContain("GET /gmail/v1/users/me/messages/one?");
      expect(String(options.body)).not.toContain("Authorization:");
      return response([
        { index: 1, id: "two" },
        { index: 0, id: "one" },
      ]);
    },
  );
  expect(calls).toBe(1);
  expect(rows.map((r) => r.id)).toEqual(["one", "two"]);
});
for (const [name, rows] of [
  ["missing", [{ index: 0, id: "one" }]],
  [
    "duplicate",
    [
      { index: 0, id: "one" },
      { index: 0, id: "one" },
    ],
  ],
  [
    "wrong message",
    [
      { index: 0, id: "another" },
      { index: 1, id: "two" },
    ],
  ],
  [
    "failed part",
    [
      { index: 0, id: "one", status: 429 },
      { index: 1, id: "two" },
    ],
  ],
  [
    "unowned part",
    [
      { index: 3, id: "one" },
      { index: 1, id: "two" },
    ],
  ],
] as const)
  test(`reject ${name} without a partial mailbox`, async () => {
    await expect(
      readGmailMetadataBatch(["one", "two"], [], async () => response([...rows])),
    ).rejects.toThrow();
  });
test("bounded body, malformed framing and abort fail closed", async () => {
  await expect(
    readGmailMetadataBatch(
      ["one"],
      [],
      async () =>
        new Response("x".repeat(2 * 1024 * 1024 + 1), {
          headers: { "Content-Type": "multipart/mixed; boundary=batch_owned" },
        }),
    ),
  ).rejects.toThrow("too large");
  await expect(
    readGmailMetadataBatch(
      ["one"],
      [],
      async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
    ),
  ).rejects.toThrow("framing");
  const abort = new AbortController();
  abort.abort();
  let called = false;
  await expect(
    readGmailMetadataBatch(
      ["one"],
      [],
      async () => {
        called = true;
        return response([]);
      },
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
});
test("HTML preserves complete markup, declared charset and rejects truncated views", () => {
  const html = "<table><tr><td>Owned HTML</td></tr></table>";
  expect(
    extractGmailHtmlView({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Plain").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } },
      ],
    }),
  ).toEqual({ html, status: "available" });
  const cp = extractGmailHtmlView({
    mimeType: "text/html",
    headers: [{ name: "Content-Type", value: "text/html; charset=windows-1252" }],
    body: { data: Buffer.from([0x80]).toString("base64url") },
  });
  expect(cp.html).toBe("€");
  expect(
    extractGmailHtmlView({
      mimeType: "text/html",
      body: { data: Buffer.from("x".repeat(512 * 1024 + 1)).toString("base64url") },
    }),
  ).toEqual({ html: null, status: "too-large" });
  expect(
    extractGmailHtmlView({
      mimeType: "text/html",
      filename: "attached.html",
      body: { data: Buffer.from(html).toString("base64url") },
    }).html,
  ).toBe(null);
});
test("explicit Spam, Trash and anywhere queries only", () => {
  for (const q of ["in:spam", "in:trash", "in:anywhere", "from:a@b.test IN:SPAM"])
    expect(gmailSearchIncludesTrash(q)).toBe(true);
  for (const q of ["in:inbox", "-in:spam -in:trash", "subject:in:spam", "in:spammy"])
    expect(gmailSearchIncludesTrash(q)).toBe(false);
});
