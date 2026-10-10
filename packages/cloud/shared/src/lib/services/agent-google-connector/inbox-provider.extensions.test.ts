import { expect, test } from "bun:test";
import { decodeGmailPartData, extractGmailHtmlLinks } from "../../utils/gmail-mime-text";
import { InboxGoogleProvider, inboxDigest } from "./inbox-provider";

// Closed in-process transport: every request is answered by `route`; nothing reaches Google.
const owner = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  grantId: "00000000-0000-4000-8000-000000000004",
};
type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
function provider(route: Route, scopes = ["https://www.googleapis.com/auth/gmail.modify"]) {
  const requests: string[] = [];
  return {
    requests,
    provider: new InboxGoogleProvider({
      grant: async () => ({ token: "synthetic-only", email: "owner@example.invalid", scopes }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://gmail.googleapis.com");
        requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
        return route(url, init);
      },
      normalizeMessage: (raw) => {
        const payload = raw.payload as Record<string, unknown>;
        const plain = (payload?.parts as Array<Record<string, any>> | undefined)?.find(
          (p) => p.mimeType === "text/plain",
        );
        return {
          message: { externalId: raw.id, threadId: raw.threadId },
          bodyText: plain ? decodeGmailPartData(plain.body.data) : "",
          links: extractGmailHtmlLinks(payload),
        };
      },
    }),
  };
}
const b64 = (text: string) => Buffer.from(text).toString("base64url");

test("thread messages carry inert links extracted from HTML parts", async () => {
  const { provider: inbox } = provider(() =>
    Response.json({
      id: "thread1",
      historyId: "9",
      messages: [
        {
          id: "m1",
          threadId: "thread1",
          historyId: "9",
          internalDate: "1000",
          payload: {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64("Plain https://plain.example.org/") } },
              {
                mimeType: "text/html",
                body: { data: b64('<a href="https://html.example.org/a">Open</a>') },
              },
            ],
          },
        },
      ],
    }),
  );
  const page = await inbox.thread(owner, "thread1");
  expect(page.messages[0]?.links).toEqual([{ href: "https://html.example.org/a", text: "Open" }]);
  expect(page.messages[0]?.bodyText).toBe("Plain https://plain.example.org/");
});

test("capabilities advertise Trash search with the read scope only", async () => {
  expect(
    (await provider(() => new Response(null, { status: 404 })).provider.capabilities(owner))
      .searchTrash,
  ).toBe(true);
  const metadataOnly = provider(
    () => new Response(null, { status: 404 }),
    ["https://www.googleapis.com/auth/gmail.send"],
  );
  expect((await metadataOnly.provider.capabilities(owner)).searchTrash).toBe(false);
});

test("drafts list and exact draft content from one provider snapshot", async () => {
  let rawMessageId = "dm1";
  let mutatePayload: (payload: any) => void = () => {};
  const header = (name: string, value: string) => ({ name, value });
  const rawMime = Buffer.from("To: friend@example.invalid\r\nSubject: Plan\r\n\r\nBody").toString(
    "base64url",
  );
  const { provider: inbox, requests } = provider((url) => {
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/drafts") {
      expect(url.searchParams.get("maxResults")).toBe("25");
      return Response.json(
        url.searchParams.get("pageToken")
          ? { drafts: [{ id: "d3" }] }
          : { drafts: [{ id: "d1" }, { id: "d2" }], nextPageToken: "page-2" },
      );
    }
    const id = path.split("/")[2];
    const format = url.searchParams.get("format");
    if (format === "metadata")
      return Response.json({
        id,
        message: {
          id: `${id}m`,
          internalDate: "1790000000000",
          snippet: "Draft preview",
          payload: {
            headers: [
              header("Subject", `Subject ${id}`),
              header("To", '"Friend, A" <friend@example.invalid>, other@example.invalid'),
            ],
          },
        },
      });
    if (format === "raw") return Response.json({ id, message: { id: rawMessageId, raw: rawMime } });
    if (format === "full") {
      const plain = {
        mimeType: "text/plain",
        headers: [header("Content-Type", "text/plain; charset=windows-1252")],
        body: { data: Buffer.from([0x93, 0x48, 0x69, 0x94]).toString("base64url") },
      };
      const payloads: Record<string, unknown> = {
        d1: {
          mimeType: "multipart/alternative",
          headers: [
            header("To", "friend@example.invalid"),
            header("Cc", "Copy <copy@example.invalid>"),
            header("Bcc", "hidden@example.invalid"),
            header("Subject", "Plan"),
          ],
          parts: [plain, { mimeType: "text/html", body: { data: "PHA-SGk8L3A-" } }],
        },
        d2: {
          mimeType: "text/plain",
          headers: [header("Subject", "Re: Thread"), header("In-Reply-To", "<p@example.invalid>")],
          body: { data: "SGk" },
        },
        d4: {
          mimeType: "text/html",
          headers: [header("Subject", "Html only")],
          body: { data: "PHA-SGk8L3A-" },
        },
        d5: {
          mimeType: "multipart/mixed",
          headers: [header("Subject", "Attached")],
          parts: [
            plain,
            {
              mimeType: "application/pdf",
              filename: "a.pdf",
              body: { attachmentId: "att", size: 9 },
            },
          ],
        },
      };
      mutatePayload(payloads[id]);
      return Response.json({ id, message: { id: "dm1", payload: payloads[id] } });
    }
    return new Response("unexpected", { status: 404 });
  });
  const page = await inbox.drafts(owner);
  expect(page).toEqual({
    version: 1,
    drafts: ["d1", "d2"].map((id) => ({
      draftId: id,
      messageId: `${id}m`,
      subject: `Subject ${id}`,
      to: ["friend@example.invalid", "other@example.invalid"],
      snippet: "Draft preview",
      updatedAt: new Date(1790000000000).toISOString(),
    })),
    nextPageToken: "page-2",
  });
  expect((await inbox.drafts(owner, "page-2")).nextPageToken).toBeNull();
  await expect(inbox.drafts(owner, "")).rejects.toThrow("Invalid Gmail page token");
  const content = await inbox.draftContent(owner, "d1");
  expect(content).toMatchObject({
    id: "d1",
    messageId: "dm1",
    content: {
      to: ["friend@example.invalid"],
      cc: ["copy@example.invalid"],
      bcc: ["hidden@example.invalid"],
      subject: "Plan",
      bodyText: "“Hi”",
      plainText: true,
      threaded: false,
      attachmentCount: 0,
    },
  });
  expect(content.providerDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await inbox.draftContent(owner, "d2")).content.threaded).toBe(true);
  expect((await inbox.draftContent(owner, "d4")).content.plainText).toBe(false);
  expect((await inbox.draftContent(owner, "d5")).content.attachmentCount).toBe(1);
  for (const mutate of [
    (payload: any) => {
      payload.headers[3].value = "=?utf-8?B?SGVsbG8=?=";
    },
    (payload: any) => {
      payload.parts[0].body = { attachmentId: "external-body", size: 10 };
    },
    (payload: any) => {
      payload.headers[0].value = Array.from(
        { length: 51 },
        (_, i) => `person${i}@example.invalid`,
      ).join(", ");
    },
    (payload: any) => {
      payload.headers.push(header("To", "extra@example.invalid"));
    },
    (payload: any) => {
      payload.headers.push(header("Subject", "Another subject"));
    },
    (payload: any) => {
      payload.parts[0].headers = [header("Content-Type", "text/plain; charset=utf-8")];
      payload.parts[0].body.data = Buffer.from([0xff]).toString("base64url");
    },
    (payload: any) => {
      payload.parts[0].headers = [header("Content-Type", "text/plain; charset=unknown-encoding")];
    },
  ]) {
    mutatePayload = mutate;
    await expect(inbox.draftContent(owner, "d1")).rejects.toThrow();
  }
  mutatePayload = () => {};
  rawMessageId = "changed";
  await expect(inbox.draftContent(owner, "d1")).rejects.toThrow("Draft changed while it was read");
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  expect((await inbox.capabilities(owner)).draftsList).toBe(true);
});

const pdf = Buffer.from("%PDF-1.4 synthetic"),
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
  txt = Buffer.from("plain notes"),
  docx = Buffer.from("PK\u0003\u0004synthetic-docx"),
  zip = Buffer.from("PK\u0003\u0004synthetic-zip");
const sha = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
function parseMime(raw: string) {
  const parser = Bun.spawnSync(
    [
      "/usr/bin/python3",
      "-c",
      'import sys,json,hashlib,email.policy,email.parser; m=email.parser.BytesParser(policy=email.policy.default).parsebytes(sys.stdin.buffer.read()); print(json.dumps({"type":m.get_content_type(),"defects":[str(x) for x in m.defects],"body":next(m.iter_parts()).get_content() if m.is_multipart() else m.get_content(),"files":[{"name":p.get_filename(),"type":p.get_content_type(),"sha256":hashlib.sha256(p.get_content() if isinstance(p.get_content(),bytes) else p.get_content().encode()).hexdigest()} for p in m.iter_attachments()]}))',
    ],
    { stdin: Buffer.from(raw, "base64url") },
  );
  if (parser.exitCode !== 0) throw Error(`Standard-library MIME parsing failed: ${parser.stderr}`);
  return JSON.parse(parser.stdout.toString()) as {
    type: string;
    defects: string[];
    body: string;
    files: { name: string; type: string; sha256: string }[];
  };
}
function sourceMessageRoute(state: { historyId: string; sends: string[] }): Route {
  return async (url, init) => {
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/messages/source" && url.searchParams.get("format") === "full")
      return Response.json({
        id: "source",
        threadId: "t",
        historyId: state.historyId,
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { partId: "0", mimeType: "text/plain", body: { data: "SGk", size: 2 } },
            {
              partId: "1",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              filename: "report.docx",
              body: { attachmentId: "att-docx", size: docx.length },
            },
            {
              partId: "2",
              mimeType: "text/plain",
              filename: "notes.txt",
              body: { data: txt.toString("base64url"), size: txt.length },
            },
            {
              partId: "3",
              mimeType: "application/zip",
              filename: "bundle.zip",
              body: { attachmentId: "att-zip", size: zip.length },
            },
            {
              partId: "4",
              mimeType: "application/zip",
              filename: "huge.zip",
              body: { attachmentId: "att-huge", size: 6 * 1024 * 1024 },
            },
          ],
        },
      });
    if (path === "/messages/source/attachments/att-docx")
      return Response.json({ size: docx.length, data: docx.toString("base64url") });
    if (path === "/messages/source/attachments/att-zip")
      return Response.json({ size: zip.length, data: zip.toString("base64url") });
    if (path === "/messages/send" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { raw: string };
      state.sends.push(body.raw);
      return Response.json({ id: `sent${state.sends.length}`, threadId: "t2" });
    }
    return new Response("unexpected", { status: 404 });
  };
}
const compose = {
  kind: "send",
  mode: "compose",
  to: ["friend@example.invalid"],
  subject: "Files",
  bodyText: "Three files",
};
const file = (name: string, mimeType: string, bytes: Buffer) => ({
  name,
  mimeType,
  dataBase64: bytes.toString("base64"),
});

test("three attachments in one reviewed send; MIME parts and digests match the review", async () => {
  const state = { historyId: "h1", sends: [] as string[] };
  const { provider: inbox } = provider(sourceMessageRoute(state));
  const caps = await inbox.capabilities(owner);
  expect(caps.attachmentPolicy).toMatchObject({
    maximumOutgoing: 10,
    maximumTotalBytes: 5 * 1024 * 1024,
  });
  expect([caps.forwardAttachments, caps.opaqueAttachments]).toEqual([true, true]);
  const reviewed = await inbox.review(
    owner,
    {
      ...compose,
      attachments: [
        file("a.pdf", "application/pdf", pdf),
        file("b.png", "image/png", png),
        file("c.txt", "text/plain", txt),
      ],
    },
    crypto.randomUUID(),
  );
  expect(reviewed.review.attachments).toEqual([
    { name: "a.pdf", mimeType: "application/pdf", size: pdf.length, sha256: sha(pdf) },
    { name: "b.png", mimeType: "image/png", size: png.length, sha256: sha(png) },
    { name: "c.txt", mimeType: "text/plain", size: txt.length, sha256: sha(txt) },
  ]);
  expect(reviewed.review.forwardedAttachments).toBeUndefined();
  expect(reviewed.digest).toBe(await inboxDigest(JSON.stringify(reviewed.review)));
  expect(state.sends).toHaveLength(0);
  const result = await reviewed.perform();
  expect(state.sends).toHaveLength(1);
  expect(result.mimeDigest).toBe(reviewed.review.mimeDigest);
  expect(await inboxDigest(state.sends[0])).toBe(reviewed.review.mimeDigest as string);
  const parsed = parseMime(state.sends[0]);
  expect(parsed.type).toBe("multipart/mixed");
  expect(parsed.defects).toEqual([]);
  expect(parsed.body).toBe("Three files");
  expect(parsed.files).toEqual([
    { name: "a.pdf", type: "application/pdf", sha256: sha(pdf) },
    { name: "b.png", type: "image/png", sha256: sha(png) },
    { name: "c.txt", type: "text/plain", sha256: sha(txt) },
  ]);
  const many = Array.from({ length: 11 }, (_, i) => file(`${i}.txt`, "text/plain", txt));
  await expect(
    inbox.review(owner, { ...compose, attachments: many }, crypto.randomUUID()),
  ).rejects.toThrow("At most 10");
  await expect(
    inbox.review(
      owner,
      {
        ...compose,
        attachments: [file("x.txt", "text/plain", txt), file("X.TXT", "text/plain", txt)],
      },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("unique");
  const big = Buffer.alloc(3 * 1024 * 1024, 65);
  await expect(
    inbox.review(
      owner,
      {
        ...compose,
        attachments: [file("a.txt", "text/plain", big), file("b.txt", "text/plain", big)],
      },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("5 MiB in total");
});

test("forward carries source attachments bound to the selected message and historyId", async () => {
  const state = { historyId: "h1", sends: [] as string[] };
  const { provider: inbox } = provider(sourceMessageRoute(state));
  const proposal = {
    kind: "send",
    mode: "forward",
    to: ["friend@example.invalid"],
    subject: "Fwd: Source",
    bodyText: "Forwarded",
    attachments: [file("mine.pdf", "application/pdf", pdf)],
    forwardAttachments: { messageId: "source", historyId: "h1", partIds: ["1", "2"] },
  };
  const reviewed = await inbox.review(owner, proposal, crypto.randomUUID());
  expect(reviewed.review.forwardSource).toEqual({ messageId: "source", historyId: "h1" });
  expect(reviewed.review.forwardedAttachments).toEqual([
    {
      partId: "1",
      name: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: docx.length,
      sha256: sha(docx),
    },
    { partId: "2", name: "notes.txt", mimeType: "text/plain", size: txt.length, sha256: sha(txt) },
  ]);
  await reviewed.perform();
  expect(parseMime(state.sends[0]).files.map((f) => [f.name, f.sha256])).toEqual([
    ["mine.pdf", sha(pdf)],
    ["report.docx", sha(docx)],
    ["notes.txt", sha(txt)],
  ]);
  state.historyId = "h2";
  await expect(inbox.review(owner, proposal, crypto.randomUUID())).rejects.toThrow(
    "Selected message changed",
  );
  state.historyId = "h1";
  await expect(
    inbox.review(owner, { ...proposal, mode: "compose", subject: "x" }, crypto.randomUUID()),
  ).rejects.toThrow("only for a forward");
  await expect(
    inbox.review(
      owner,
      { ...proposal, forwardAttachments: { ...proposal.forwardAttachments, partIds: ["9"] } },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("Source attachment not found");
  await expect(
    inbox.review(
      owner,
      { ...proposal, forwardAttachments: { ...proposal.forwardAttachments, partIds: ["4"] } },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("at most 5 MiB");
  const sendOnly = provider(sourceMessageRoute(state), [
    "https://www.googleapis.com/auth/gmail.send",
  ]);
  await expect(sendOnly.provider.review(owner, proposal, crypto.randomUUID())).rejects.toThrow(
    "lacks this capability",
  );
});

test("opaque byte copy of an unsupported docx or zip, bound to message, part and historyId", async () => {
  const state = { historyId: "h1", sends: [] as string[] };
  const { provider: inbox } = provider(sourceMessageRoute(state));
  for (const [partId, bytes, name, mimeType] of [
    [
      "1",
      docx,
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["3", zip, "bundle.zip", "application/zip"],
  ] as const) {
    const copy = await inbox.opaqueAttachment(owner, "source", partId, "h1");
    expect(copy).toEqual({
      version: 1,
      opaque: true,
      messageId: "source",
      partId,
      historyId: "h1",
      name,
      mimeType,
      dataBase64: bytes.toString("base64"),
      size: bytes.length,
      sha256: sha(bytes),
    });
  }
  await expect(inbox.attachment(owner, "source", "3", "h1")).rejects.toThrow(
    "Supported PDF, image or TXT",
  );
  await expect(inbox.opaqueAttachment(owner, "source", "3", "stale")).rejects.toThrow(
    "Message changed",
  );
  await expect(inbox.opaqueAttachment(owner, "source", "4", "h1")).rejects.toThrow("at most 5 MiB");
  await expect(inbox.opaqueAttachment(owner, "source", "8", "h1")).rejects.toThrow(
    "Attachment not found",
  );
  expect(state.sends).toHaveLength(0);
});

test("draft listing refuses content if consent is withdrawn during its provider read", async () => {
  const scopes = ["https://www.googleapis.com/auth/gmail.modify"];
  const { provider: inbox } = provider(() => {
    scopes.length = 0;
    return Response.json({ drafts: [] });
  }, scopes);
  await expect(inbox.drafts(owner)).rejects.toThrow();
});
