import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createInboxOperationRoutes } from "./inbox-operation-routes";
import { DefiniteProviderRejection, InboxContractError, InboxReceipts } from "./inbox-receipts";

const org = "00000000-0000-4000-8000-000000000001",
  user = "00000000-0000-4000-8000-000000000002",
  other = "00000000-0000-4000-8000-000000000003",
  grant = "00000000-0000-4000-8000-000000000004";
const database = new PGlite(),
  dialect = new PgDialect(),
  orm = {
    execute: async (query: SQL) => {
      const prepared = dialect.sqlToQuery(query);
      return database.query(prepared.sql, prepared.params);
    },
  },
  receipts = new InboxReceipts(async (query) => {
    const result = await orm.execute(query);
    return { rows: result.rows as Record<string, unknown>[] };
  });
let posts = 0,
  mode: "ok" | "lost" | "rejected" = "ok";
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (
      new URL(request.url).pathname !== "/gmail/v1/users/me/messages/send" ||
      request.method !== "POST"
    )
      return new Response("unexpected", { status: 404 });
    posts++;
    const body = (await request.json()) as { raw: string };
    const decoded = Buffer.from(body.raw, "base64url").toString("utf8");
    if (!decoded.startsWith("To: synthetic@example.invalid\r\n"))
      return new Response("invalid MIME", { status: 400 });
    if (mode === "rejected") return Response.json({ error: "fixture refusal" }, { status: 403 });
    if (mode === "lost") return new Response("broken committed result", { status: 200 });
    return Response.json({ id: "synthetic-message-" + posts, threadId: "synthetic-thread" });
  },
});
const app = createInboxOperationRoutes({
  receipts,
  async authenticate(context) {
    const value = context.req.header("x-fixture-owner");
    if (value !== user && value !== other)
      throw new InboxContractError(401, "Fixture authentication required");
    return { organizationId: org, userId: value };
  },
  async review(owner, proposal) {
    if (owner.grantId !== (owner.userId === user ? grant : "00000000-0000-4000-8000-000000000005"))
      throw new InboxContractError(404, "Grant not found");
    if (
      !proposal ||
      typeof proposal !== "object" ||
      (proposal as { kind?: string }).kind !== "send" ||
      typeof (proposal as { body?: string }).body !== "string"
    )
      throw new InboxContractError(400, "Invalid reviewed proposal");
    const raw = Buffer.from(
      "To: synthetic@example.invalid\r\nSubject: Synthetic\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" +
        (proposal as { body: string }).body,
    ).toString("base64url");
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
    ).toString("hex");
    return {
      kind: "send",
      digest,
      review: { to: ["synthetic@example.invalid"] },
      perform: async () => {
        const response = await fetch(
          `http://127.0.0.1:${provider.port}/gmail/v1/users/me/messages/send`,
          { method: "POST", body: JSON.stringify({ raw }) },
        );
        if (response.status === 403) throw new DefiniteProviderRejection("403");
        const result = (await response.json()) as { id: string; threadId: string };
        if (typeof result.id !== "string") throw Error("Invalid provider response");
        return result;
      },
    };
  },
});
const request = (path: string, body?: unknown, identity = user) =>
  app.request("http://fixture" + path, {
    method: body ? "POST" : "GET",
    headers: { "x-fixture-owner": identity, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
afterAll(async () => {
  provider.stop(true);
  await database.close();
});
test("real Hono route + PostgreSQL migration + HTTP provider: admission, response loss, no replay, owner scope and immutable receipt", async () => {
  await database.exec(
    "CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);",
  );
  await database.query("INSERT INTO organizations VALUES ($1)", [org]);
  await database.query("INSERT INTO users VALUES ($1),($2)", [user, other]);
  for (const migration of [
    "0509_managed_gmail_operation_receipts.sql",
    "0535_managed_gmail_read_state_operations.sql",
  ])
    await database.exec(
      readFileSync(new URL(`../../../db/migrations/${migration}`, import.meta.url), "utf8"),
    );
  const operation = crypto.randomUUID(),
    proposal = { kind: "send", body: "Exact reviewed body" };
  expect(
    (await request("/operations", { grantId: grant, requestId: operation, proposal }, "")).status,
  ).toBe(401);
  expect(
    (await request("/operations", { grantId: grant, requestId: operation, proposal }, other))
      .status,
  ).toBe(404);
  const foreignGrant = "00000000-0000-4000-8000-000000000005";
  expect(
    (await request("/operations", { grantId: foreignGrant, requestId: operation, proposal }, other))
      .status,
  ).toBe(200);
  expect((await request(`/operations/${operation}?grantId=${foreignGrant}`)).status).toBe(404);
  const prepared = (await (
    await request("/operations", { grantId: grant, requestId: operation, proposal })
  ).json()) as any;
  expect(prepared.receipt.state).toBe("prepared");
  expect(posts).toBe(0);
  expect(prepared.providerExactlyOnce).toBe(false);
  expect(
    (
      await request("/operations", {
        grantId: grant,
        requestId: operation,
        proposal: { kind: "send", body: "changed" },
      })
    ).status,
  ).toBe(409);
  const dispatch = { grantId: grant, reviewDigest: prepared.receipt.reviewDigest, proposal };
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => request(`/operations/${operation}/dispatch`, dispatch)),
  );
  expect(responses.every((r) => r.status === 200)).toBe(true);
  expect(posts).toBe(1);
  expect(
    ((await (await request(`/operations/${operation}?grantId=${grant}`)).json()) as any).receipt
      .state,
  ).toBe("succeeded");
  expect(
    (await request(`/operations/${operation}?grantId=${grant}`, undefined, other)).status,
  ).toBe(404);
  expect(
    (
      await request(`/operations/${operation}/dispatch`, {
        ...dispatch,
        reviewDigest: "0".repeat(64),
      })
    ).status,
  ).toBe(409);
  await expect(
    orm.execute(
      sql`UPDATE managed_gmail_operation_receipts SET state='prepared',provider_result=NULL,dispatched_at=NULL,finished_at=NULL WHERE request_id=${operation}`,
    ),
  ).rejects.toThrow();
  await expect(
    orm.execute(
      sql`UPDATE managed_gmail_operation_receipts SET review_digest=${"f".repeat(64)} WHERE request_id=${operation}`,
    ),
  ).rejects.toThrow();
  mode = "lost";
  const lost = crypto.randomUUID(),
    p = (await (
      await request("/operations", { grantId: grant, requestId: lost, proposal })
    ).json()) as any;
  const lostDispatch = { grantId: grant, reviewDigest: p.receipt.reviewDigest, proposal };
  const result = (await (
    await request(`/operations/${lost}/dispatch`, lostDispatch)
  ).json()) as any;
  expect(result.receipt.state).toBe("outcome-unknown");
  expect(posts).toBe(2);
  const reconstructed = new InboxReceipts(async (query) => ({
    rows: (await orm.execute(query)).rows as Record<string, unknown>[],
  }));
  expect(
    (await reconstructed.get({ organizationId: org, userId: user, grantId: grant }, lost)).state,
  ).toBe("outcome-unknown");
  for (let i = 0; i < 3; i++)
    expect(
      ((await (await request(`/operations/${lost}/dispatch`, lostDispatch)).json()) as any).receipt
        .state,
    ).toBe("outcome-unknown");
  expect(posts).toBe(2);
  mode = "rejected";
  const denied = crypto.randomUUID(),
    d = (await (
      await request("/operations", { grantId: grant, requestId: denied, proposal })
    ).json()) as any;
  expect(
    (
      (await (
        await request(`/operations/${denied}/dispatch`, {
          grantId: grant,
          reviewDigest: d.receipt.reviewDigest,
          proposal,
        })
      ).json()) as any
    ).receipt.state,
  ).toBe("rejected");
  expect(posts).toBe(3);
  expect(
    (
      await request("/operations", {
        grantId: grant,
        requestId: crypto.randomUUID(),
        proposal,
        side: "agent",
      })
    ).status,
  ).toBe(400);
  const columns = await database.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name=$1",
    ["managed_gmail_operation_receipts"],
  );
  expect(columns.rows.some((row) => /token|body|raw|recipient/.test(row.column_name))).toBe(false);
}, 60000);

test("managed provider review produces parseable MIME, binds reply headers, detects changed drafts and reads exact mailbox labels over HTTP", async () => {
  const { InboxGoogleProvider, inboxDigest } = await import("./inbox-provider");
  const owner = { organizationId: org, userId: user, grantId: grant };
  let sends = 0,
    rawSaved = "",
    draftRevision = 0,
    wrongReplyIdentity = false;
  const parsedMessages: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== "Bearer synthetic-only")
        return new Response("bad synthetic token", { status: 401 });
      if (url.pathname.endsWith("/messages/parent") && request.method === "GET")
        return Response.json({
          id: wrongReplyIdentity ? "different" : "parent",
          threadId: "thread",
          historyId: "7",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "Subject", value: "Prior message" },
              { name: "Message-ID", value: "<parent@example.invalid>" },
              { name: "References", value: "<ancestor@example.invalid>" },
            ],
          },
        });
      if (url.pathname.endsWith("/messages/parent/modify"))
        return Response.json({ id: "parent", threadId: "thread", historyId: "8", labelIds: [] });
      if (url.pathname.endsWith("/messages/send") && request.method === "POST") {
        sends++;
        const body = (await request.json()) as { raw: string };
        const parser = Bun.spawnSync(
          [
            "/usr/bin/python3",
            "-c",
            'import sys,json,email.policy,email.parser; m=email.parser.BytesParser(policy=email.policy.default).parsebytes(sys.stdin.buffer.read()); print(json.dumps({"to":str(m["To"]),"bcc":str(m["Bcc"] or ""),"subject":str(m["Subject"]),"from":str(m["From"]),"inReplyTo":str(m["In-Reply-To"] or ""),"references":str(m["References"] or ""),"body":m.get_content(),"defects":[str(x) for x in m.defects]}))',
          ],
          { stdin: Buffer.from(body.raw, "base64url") },
        );
        if (parser.exitCode !== 0) throw Error("Standard-library MIME parsing failed");
        parsedMessages.push(JSON.parse(parser.stdout.toString()));
        return Response.json({ id: "sent" + sends, threadId: "thread" });
      }
      if (url.pathname.endsWith("/drafts") && request.method === "POST") {
        const body = (await request.json()) as any;
        rawSaved = body.message.raw;
        draftRevision++;
        return Response.json({ id: "draft1", message: { id: "draftmessage" + draftRevision } });
      }
      if (url.pathname.endsWith("/drafts/draft1") && request.method === "GET")
        return Response.json({
          id: "draft1",
          message: { id: "draftmessage" + draftRevision, raw: rawSaved },
        });
      if (url.pathname.endsWith("/drafts/draft1") && request.method === "PUT") {
        const body = (await request.json()) as any;
        rawSaved = body.message.raw;
        draftRevision++;
        return Response.json({ id: "draft1", message: { id: "draftmessage" + draftRevision } });
      }
      if (url.pathname.endsWith("/drafts/draft1") && request.method === "DELETE") {
        rawSaved = "";
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected synthetic provider path", { status: 404 });
    },
  });
  const provider = new InboxGoogleProvider({
    grant: async (selected) => {
      if (selected.userId !== user || selected.grantId !== grant)
        throw new InboxContractError(404, "Grant unavailable");
      return {
        token: "synthetic-only",
        email: "owner@example.invalid",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      };
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://gmail.googleapis.com");
      return fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
    },
  });
  try {
    const proposal = {
      kind: "send",
      mode: "compose",
      to: ["synthetic@example.invalid"],
      bcc: ["hidden@example.invalid"],
      subject: "Résumé — " + "long ".repeat(25),
      bodyText: "Hello café\nSecond line",
    };
    const reviewed = await provider.review(owner, proposal, crypto.randomUUID());
    expect(sends).toBe(0);
    await reviewed.perform();
    expect(sends).toBe(1);
    expect(parsedMessages[0].defects).toEqual([]);
    expect(parsedMessages[0].subject).toBe(proposal.subject);
    expect(parsedMessages[0].body).toBe("Hello café\r\nSecond line");
    expect(parsedMessages[0].bcc).toBe("hidden@example.invalid");
    expect(parsedMessages[0].from).toBe("owner@example.invalid");
    await expect(
      provider.review(
        owner,
        { ...proposal, subject: "Bad\r\nBcc: attacker@example.invalid" },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    await expect(
      provider.review(
        owner,
        { ...proposal, to: ["Display <synthetic@example.invalid>"] },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    const reply = await provider.review(
      owner,
      { ...proposal, mode: "reply", subject: "Re: Prior message", replyMessageId: "parent" },
      crypto.randomUUID(),
    );
    await reply.perform();
    expect(parsedMessages[1].inReplyTo).toBe("<parent@example.invalid>");
    expect(parsedMessages[1].references).toBe(
      "<ancestor@example.invalid> <parent@example.invalid>",
    );
    wrongReplyIdentity = true;
    await expect(
      provider.review(
        owner,
        { ...proposal, mode: "reply", subject: "Re: Prior message", replyMessageId: "parent" },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("Selected message lacks safe reply headers");
    wrongReplyIdentity = false;
    const manyRecipients = await provider.review(
      owner,
      { ...proposal, to: Array.from({ length: 10 }, (_, i) => `synthetic${i}@example.invalid`) },
      crypto.randomUUID(),
    );
    await manyRecipients.perform();
    expect(parsedMessages[2].to.split(",")).toHaveLength(10);
    const created = await (
      await provider.review(owner, { ...proposal, kind: "draft-create" }, crypto.randomUUID())
    ).perform();
    expect(created.draftId).toBe("draft1");
    expect(created.providerDigest).toBe(await inboxDigest(rawSaved));
    rawSaved = Buffer.from("Changed externally").toString("base64url");
    await expect(
      provider.review(
        owner,
        {
          ...proposal,
          kind: "draft-replace",
          draftId: "draft1",
          expectedDigest: created.providerDigest,
          acceptNonAtomicReplacement: true,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("Provider draft changed");
    const before = await provider.draft(owner, "draft1");
    const replaced = await (
      await provider.review(
        owner,
        {
          ...proposal,
          kind: "draft-replace",
          draftId: "draft1",
          expectedDigest: before.providerDigest,
          acceptNonAtomicReplacement: true,
        },
        crypto.randomUUID(),
      )
    ).perform();
    expect(replaced.atomicReplacement).toBe(false);
    expect(
      (
        await (
          await provider.review(
            owner,
            { kind: "archive", messageId: "parent", expectedHistoryId: "7" },
            crypto.randomUUID(),
          )
        ).perform()
      ).labelIds,
    ).toEqual([]);
    await expect(
      provider.review(
        owner,
        { kind: "archive", messageId: "parent", expectedHistoryId: "stale" },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    await expect(
      provider.review(
        owner,
        { kind: "draft-delete", draftId: "draft1", expectedDigest: replaced.providerDigest },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    expect(
      (
        await (
          await provider.review(
            owner,
            {
              kind: "draft-delete",
              draftId: "draft1",
              expectedDigest: replaced.providerDigest,
              confirmPermanentDelete: true,
            },
            crypto.randomUUID(),
          )
        ).perform()
      ).deleted,
    ).toBe(true);
  } finally {
    server.stop(true);
  }
}, 30000);

test("actual HTTP full thread pages retain provider history identity and reject mixed snapshots", async () => {
  const { InboxGoogleProvider } = await import("./inbox-provider");
  let history = "history1";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/gmail/v1/users/me/threads/thread");
      return Response.json({
        id: "thread",
        historyId: history,
        messages: Array.from({ length: 26 }, (_, i) => ({
          id: `message${25 - i}`,
          threadId: "thread",
          internalDate: String(1000 + 25 - i),
          payload: { body: { data: Buffer.from(`Synthetic ${25 - i}`).toString("base64url") } },
        })),
      });
    },
  });
  try {
    const provider = new InboxGoogleProvider({
      grant: async () => ({
        token: "synthetic-only",
        email: "owner@example.invalid",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://gmail.googleapis.com");
        return fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
      },
      normalizeMessage: (raw) => ({
        message: { externalId: raw.id, threadId: raw.threadId },
        bodyText: Buffer.from((raw.payload as any).body.data, "base64url").toString("utf8"),
      }),
    });
    const owner = { organizationId: org, userId: user, grantId: grant },
      first = await provider.thread(owner, "thread");
    expect(first.total).toBe(26);
    expect(first.messages.length).toBe(25);
    expect(first.messages[0].message.externalId).toBe("message0");
    expect(first.nextOffset).toBe(25);
    const second = await provider.thread(owner, "thread", 25, first.historyId);
    expect(second.messages[0].bodyText).toBe("Synthetic 25");
    expect(second.nextOffset).toBeNull();
    await expect(provider.thread(owner, "thread", 25)).rejects.toThrow();
    await expect(provider.thread(owner, "thread", 27, first.historyId)).rejects.toThrow();
    history = "history2";
    await expect(provider.thread(owner, "thread", 25, first.historyId)).rejects.toThrow(
      "Thread changed",
    );
  } finally {
    server.stop(true);
  }
}, 10000);

test("bounded attachments round-trip exact UTF-8 bytes and reversible mailbox changes retain identities", async () => {
  const { InboxGoogleProvider } = await import("./inbox-provider");
  const bytes = Buffer.from("Exact attachment\nCafé ✓\n"),
    owner = { organizationId: org, userId: user, grantId: grant };
  let labels = ["INBOX"],
    history = "1",
    sentRaw = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/messages/source") && request.method === "GET")
        return Response.json({
          id: "source",
          threadId: "thread",
          historyId: history,
          labelIds: labels,
          payload: {
            partId: "",
            body: { size: 0 },
            parts: [
              {
                partId: "1",
                filename: "evidence.txt",
                mimeType: "text/plain",
                body: { attachmentId: "attachment", size: bytes.length },
              },
            ],
          },
        });
      if (url.pathname.endsWith("/attachments/attachment"))
        return Response.json({ size: bytes.length, data: bytes.toString("base64url") });
      if (url.pathname.endsWith("/messages/source/modify")) {
        const body = (await request.json()) as any;
        labels = body.addLabelIds ? ["INBOX"] : [];
        history = String(Number(history) + 1);
        return Response.json({
          id: "source",
          threadId: "thread",
          historyId: history,
          labelIds: labels,
        });
      }
      if (url.pathname.endsWith("/messages/source/trash")) {
        labels = ["TRASH"];
        history = String(Number(history) + 1);
        return Response.json({
          id: "source",
          threadId: "thread",
          historyId: history,
          labelIds: labels,
        });
      }
      if (url.pathname.endsWith("/messages/source/untrash")) {
        labels = [];
        history = String(Number(history) + 1);
        return Response.json({
          id: "source",
          threadId: "thread",
          historyId: history,
          labelIds: labels,
        });
      }
      if (url.pathname.endsWith("/messages/send")) {
        sentRaw = ((await request.json()) as any).raw;
        return Response.json({ id: "sent", threadId: "thread" });
      }
      return new Response("unexpected", { status: 404 });
    },
  });
  const provider = new InboxGoogleProvider({
    grant: async () => ({
      token: "synthetic",
      email: "owner@example.invalid",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      return fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
    },
  });
  try {
    const received = await provider.attachment(owner, "source", "1", "1");
    expect(Buffer.from(received.dataBase64, "base64")).toEqual(bytes);
    await expect(provider.attachment(owner, "source", "1", "old")).rejects.toThrow("changed");
    await expect(provider.attachment(owner, "source", "wrong", "1")).rejects.toThrow("not found");
    const proposal = {
      kind: "send",
      mode: "compose",
      to: ["receiver@example.invalid"],
      subject: "Attached",
      bodyText: "Exact body",
      attachments: [
        { name: "evidence.txt", mimeType: "text/plain", dataBase64: bytes.toString("base64") },
      ],
    };
    const reviewed = await provider.review(owner, proposal, crypto.randomUUID());
    expect((reviewed.review.attachments as any[])[0].size).toBe(bytes.length);
    await reviewed.perform();
    const parser = Bun.spawnSync(
      [
        "/usr/bin/python3",
        "-c",
        'import sys,json,email.policy,email.parser,base64; m=email.parser.BytesParser(policy=email.policy.default).parsebytes(sys.stdin.buffer.read()); print(json.dumps({"body":m.get_body(preferencelist=("plain",)).get_content(),"attachments":[{"name":p.get_filename(),"data":base64.b64encode(p.get_payload(decode=True)).decode()} for p in m.iter_attachments()]}))',
      ],
      { stdin: Buffer.from(sentRaw, "base64url") },
    );
    expect(parser.exitCode).toBe(0);
    const parsed = JSON.parse(parser.stdout.toString());
    expect(parsed.body).toBe("Exact body");
    expect(parsed.attachments).toEqual([{ name: "evidence.txt", data: bytes.toString("base64") }]);
    await expect(
      provider.review(
        owner,
        { ...proposal, attachments: [{ ...proposal.attachments[0], mimeType: "text/html" }] },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    await expect(
      provider.review(
        owner,
        {
          ...proposal,
          attachments: [
            {
              ...proposal.attachments[0],
              dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
            },
          ],
        },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    for (const kind of ["archive", "unarchive", "trash", "untrash"]) {
      const effect = await provider.review(
        owner,
        { kind, messageId: "source", expectedHistoryId: history },
        crypto.randomUUID(),
      );
      const result = await effect.perform();
      expect(result.messageId).toBe("source");
      expect(result.historyId).toBe(history);
    }
    expect(labels).toEqual([]);
  } finally {
    server.stop(true);
  }
}, 10000);

test("large full-text thread pages stay below native transport bounds without truncation", async () => {
  const { InboxGoogleProvider } = await import("./inbox-provider");
  const text = "x".repeat(256 * 1024),
    owner = { organizationId: org, userId: user, grantId: grant };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        id: "thread",
        historyId: "same",
        messages: Array.from({ length: 10 }, (_, i) => ({
          id: "message" + i,
          threadId: "thread",
          internalDate: String(i),
          historyId: "same",
          payload: { body: { size: 0 } },
        })),
      }),
  });
  const provider = new InboxGoogleProvider({
    grant: async () => ({
      token: "synthetic",
      email: "self@example.invalid",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    }),
    fetch: async () => fetch(`http://127.0.0.1:${server.port}`),
    normalizeMessage: (raw) => ({
      message: { externalId: raw.id, threadId: "thread" },
      bodyText: text,
    }),
  });
  try {
    const first = await provider.thread(owner, "thread");
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.messages.length).toBeLessThan(10);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2 * 1024 * 1024);
    expect(first.messages.every((m) => m.bodyText.length === text.length)).toBe(true);
    const second = await provider.thread(owner, "thread", first.nextOffset!, first.historyId);
    expect(first.messages.length + second.messages.length).toBe(10);
    expect(second.nextOffset).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("normal binary attachment HTTP download and MIME round trip; rejects altered signatures and oversize", async () => {
  const { InboxGoogleProvider } = await import("./inbox-provider");
  let current = {
      name: "résumé.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(5 * 1024 * 1024 - 9, 32)]),
    },
    sentRaw = "";
  const owner = { organizationId: org, userId: user, grantId: grant };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST") {
        sentRaw = ((await request.json()) as { raw: string }).raw;
        return Response.json({ id: "sent", threadId: "thread" });
      }
      if (url.pathname.endsWith("/attachments/attachment"))
        return Response.json({
          size: current.bytes.length,
          data: current.bytes.toString("base64url"),
        });
      return Response.json({
        id: "source",
        historyId: "1",
        payload: {
          parts: [
            {
              partId: "1",
              filename: current.name,
              mimeType: current.mimeType,
              body: { attachmentId: "attachment", size: current.bytes.length },
            },
          ],
        },
      });
    },
  });
  const provider = new InboxGoogleProvider({
    grant: async () => ({
      token: "synthetic",
      email: "owner@example.invalid",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      return fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
    },
  });
  try {
    for (const fixture of [
      current,
      {
        name: "image.png",
        mimeType: "image/png",
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO4sAAAAASUVORK5CYII=",
          "base64",
        ),
      },
      {
        name: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]),
      },
      { name: "image.webp", mimeType: "image/webp", bytes: Buffer.from("RIFF0000WEBP0000") },
    ]) {
      current = fixture;
      const received = await provider.attachment(owner, "source", "1", "1");
      expect(Buffer.from(received.dataBase64, "base64")).toEqual(current.bytes);
      const proposal = {
        kind: "send",
        mode: "compose",
        to: ["receiver@example.invalid"],
        subject: "Binary fixture",
        bodyText: "Exact body",
        attachments: [
          {
            name: current.name,
            mimeType: current.mimeType,
            dataBase64: current.bytes.toString("base64"),
          },
        ],
      };
      const reviewed = await provider.review(owner, proposal, crypto.randomUUID());
      expect((reviewed.review.attachments as any[])[0].sha256).toBe(received.sha256);
      await reviewed.perform();
      const parser = Bun.spawnSync(
        [
          "/usr/bin/python3",
          "-c",
          'import sys,json,email.policy,email.parser,hashlib; m=email.parser.BytesParser(policy=email.policy.default).parsebytes(sys.stdin.buffer.read()); print(json.dumps([{ "name":p.get_filename(),"mime":p.get_content_type(),"sha256":hashlib.sha256(p.get_payload(decode=True)).hexdigest()} for p in m.iter_attachments()]))',
        ],
        { stdin: Buffer.from(sentRaw, "base64url") },
      );
      expect(parser.exitCode).toBe(0);
      expect(JSON.parse(parser.stdout.toString())).toEqual([
        { name: current.name, mime: current.mimeType, sha256: received.sha256 },
      ]);
      await expect(
        provider.review(
          owner,
          {
            ...proposal,
            attachments: [
              {
                ...proposal.attachments[0],
                dataBase64: Buffer.from("wrong signature").toString("base64"),
              },
            ],
          },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow("content");
    }
  } finally {
    server.stop(true);
  }
}, 30000);

test("read-state migration widens only the kind allowlist and keeps existing receipts", async () => {
  const scratch = new PGlite();
  try {
    await scratch.exec(
      "CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);",
    );
    await scratch.query("INSERT INTO organizations VALUES ($1)", [org]);
    await scratch.query("INSERT INTO users VALUES ($1)", [user]);
    const migration = (name: string) =>
      scratch.exec(
        readFileSync(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8"),
      );
    const insert = (kind: string) =>
      scratch.query(
        "INSERT INTO managed_gmail_operation_receipts (organization_id,user_id,grant_id,request_id,kind,review_digest) VALUES ($1,$2,$3,$4,$5,$6)",
        [org, user, grant, crypto.randomUUID(), kind, "a".repeat(64)],
      );
    await migration("0509_managed_gmail_operation_receipts.sql");
    const constraint = await scratch.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conrelid='managed_gmail_operation_receipts'::regclass AND pg_get_constraintdef(oid) LIKE '%untrash%'",
    );
    expect(constraint.rows.map((row) => row.conname)).toEqual([
      "managed_gmail_operation_receipts_kind_check",
    ]);
    await insert("archive");
    await expect(insert("mark-read")).rejects.toThrow();
    await migration("0535_managed_gmail_read_state_operations.sql");
    await insert("mark-read");
    await insert("mark-unread");
    await expect(insert("mark-starred")).rejects.toThrow();
    const kinds = await scratch.query<{ kind: string }>(
      "SELECT kind FROM managed_gmail_operation_receipts ORDER BY created_at, kind",
    );
    expect(kinds.rows.map((row) => row.kind).sort()).toEqual([
      "archive",
      "mark-read",
      "mark-unread",
    ]);
  } finally {
    await scratch.close();
  }
});

test("reviewed mark-read and mark-unread over a closed transport: review digest, stale, scope, request body, readback and receipts", async () => {
  const { InboxGoogleProvider, inboxDigest } = await import("./inbox-provider");
  const owner = { organizationId: org, userId: user, grantId: grant };
  let labels = ["INBOX", "UNREAD"],
    history = "40",
    readbackOverride: string[] | null = null;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const closedFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://gmail.googleapis.com")
      throw new Error("closed transport: unexpected origin");
    const method = init?.method ?? "GET",
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    if (new Headers(init?.headers).get("authorization") !== "Bearer synthetic-only")
      return new Response("bad synthetic token", { status: 401 });
    if (method === "GET" && url.pathname === "/gmail/v1/users/me/messages/target")
      return Response.json({
        id: "target",
        threadId: "thread",
        historyId: history,
        labelIds: labels,
      });
    if (method === "POST" && url.pathname === "/gmail/v1/users/me/messages/target/modify") {
      const remove: string[] = body.removeLabelIds ?? [],
        add: string[] = body.addLabelIds ?? [];
      labels = [
        ...labels.filter((label) => !remove.includes(label)),
        ...add.filter((label) => !labels.includes(label)),
      ];
      history = String(Number(history) + 1);
      return Response.json({
        id: "target",
        threadId: "thread",
        historyId: history,
        labelIds: readbackOverride ?? labels,
      });
    }
    return new Response("unexpected", { status: 404 });
  };
  let scopes = ["https://www.googleapis.com/auth/gmail.modify"];
  const provider = new InboxGoogleProvider({
    grant: async () => ({ token: "synthetic-only", email: "owner@example.invalid", scopes }),
    fetch: closedFetch,
  });
  const capabilities = await provider.capabilities(owner);
  expect(capabilities.readState).toBe(true);
  expect(capabilities.mailboxMutations).toBe(true);

  const read = await provider.review(
    owner,
    { kind: "mark-read", messageId: "target", expectedHistoryId: "40" },
    crypto.randomUUID(),
  );
  const expectedReview = {
    kind: "mark-read",
    messageId: "target",
    expectedHistoryId: "40",
    from: "owner@example.invalid",
  };
  expect(read.kind).toBe("mark-read");
  expect(read.review).toEqual(expectedReview);
  expect(read.digest).toBe(await inboxDigest(JSON.stringify(expectedReview)));
  expect(calls).toEqual([
    { method: "GET", path: "/gmail/v1/users/me/messages/target?format=minimal", body: undefined },
  ]);
  expect(await read.perform()).toEqual({
    messageId: "target",
    labelIds: ["INBOX"],
    historyId: "41",
    unread: false,
  });
  expect(calls[1]).toEqual({
    method: "POST",
    path: "/gmail/v1/users/me/messages/target/modify",
    body: { removeLabelIds: ["UNREAD"] },
  });

  const unread = await provider.review(
    owner,
    { kind: "mark-unread", messageId: "target", expectedHistoryId: "41" },
    crypto.randomUUID(),
  );
  expect(unread.review).toEqual({
    kind: "mark-unread",
    messageId: "target",
    expectedHistoryId: "41",
    from: "owner@example.invalid",
  });
  expect(unread.digest).toBe(await inboxDigest(JSON.stringify(unread.review)));
  expect(unread.digest).not.toBe(read.digest);
  expect(await unread.perform()).toEqual({
    messageId: "target",
    labelIds: ["INBOX", "UNREAD"],
    historyId: "42",
    unread: true,
  });
  expect(calls.at(-1)?.body).toEqual({ addLabelIds: ["UNREAD"] });

  const stale = provider.review(
    owner,
    { kind: "mark-read", messageId: "target", expectedHistoryId: "41" },
    crypto.randomUUID(),
  );
  await expect(stale).rejects.toBeInstanceOf(InboxContractError);
  await expect(stale).rejects.toMatchObject({
    status: 409,
    message: "Selected message changed; review its current labels",
  });
  for (const proposal of [
    { kind: "mark-read", messageId: "target", expectedHistoryId: "42", labelIds: ["UNREAD"] },
    { kind: "mark-read", messageId: "../target", expectedHistoryId: "42" },
    { kind: "mark-unread", messageId: "target", expectedHistoryId: "4\n2" },
    { kind: "mark-unread", messageId: "target" },
  ])
    await expect(provider.review(owner, proposal, crypto.randomUUID())).rejects.toMatchObject({
      status: 400,
    });

  // Readback that contradicts the requested state is not success.
  const postsBefore = calls.filter((call) => call.method === "POST").length;
  readbackOverride = ["INBOX", "UNREAD"];
  const contradicted = await provider.review(
    owner,
    { kind: "mark-read", messageId: "target", expectedHistoryId: "42" },
    crypto.randomUUID(),
  );
  await expect(contradicted.perform()).rejects.toThrow(
    "Provider labels did not verify the requested read state",
  );
  readbackOverride = [];
  const missing = await provider.review(
    owner,
    { kind: "mark-unread", messageId: "target", expectedHistoryId: history },
    crypto.randomUUID(),
  );
  await expect(missing.perform()).rejects.toThrow(
    "Provider labels did not verify the requested read state",
  );
  expect(calls.filter((call) => call.method === "POST").length).toBe(postsBefore + 2);
  readbackOverride = null;

  // Route + PostgreSQL receipt: a contradicted readback stays outcome-unknown and is never replayed.
  const scratch = new PGlite();
  try {
    await scratch.exec(
      "CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);",
    );
    await scratch.query("INSERT INTO organizations VALUES ($1)", [org]);
    await scratch.query("INSERT INTO users VALUES ($1)", [user]);
    for (const migration of [
      "0509_managed_gmail_operation_receipts.sql",
      "0535_managed_gmail_read_state_operations.sql",
    ])
      await scratch.exec(
        readFileSync(new URL(`../../../db/migrations/${migration}`, import.meta.url), "utf8"),
      );
    const scratchReceipts = new InboxReceipts(async (query) => {
      const prepared = dialect.sqlToQuery(query);
      const result = await scratch.query(prepared.sql, prepared.params);
      return { rows: result.rows as Record<string, unknown>[] };
    });
    const routes = createInboxOperationRoutes({
      receipts: scratchReceipts,
      authenticate: async () => ({ organizationId: org, userId: user }),
      review: (selected, proposal, requestId) => provider.review(selected, proposal, requestId),
    });
    const call = (path: string, body: unknown) =>
      routes.request("http://fixture" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const proposal = { kind: "mark-read", messageId: "target", expectedHistoryId: history },
      requestId = crypto.randomUUID();
    const prepared = (await (
      await call("/operations", { grantId: grant, requestId, proposal })
    ).json()) as any;
    expect(prepared.receipt).toMatchObject({ kind: "mark-read", state: "prepared" });
    expect(prepared.review).toEqual({ ...proposal, from: "owner@example.invalid" });
    const dispatch = { grantId: grant, reviewDigest: prepared.receipt.reviewDigest, proposal };
    const done = (await (await call(`/operations/${requestId}/dispatch`, dispatch)).json()) as any;
    expect(done.receipt.state).toBe("succeeded");
    expect(done.receipt.providerResult).toMatchObject({ messageId: "target", unread: false });
    expect(labels).not.toContain("UNREAD");

    readbackOverride = ["INBOX"];
    const unknownProposal = {
        kind: "mark-unread",
        messageId: "target",
        expectedHistoryId: history,
      },
      unknownId = crypto.randomUUID();
    const pending = (await (
      await call("/operations", { grantId: grant, requestId: unknownId, proposal: unknownProposal })
    ).json()) as any;
    const unknownDispatch = {
      grantId: grant,
      reviewDigest: pending.receipt.reviewDigest,
      proposal: unknownProposal,
    };
    const postsBeforeUnknown = calls.filter((c) => c.method === "POST").length;
    for (let i = 0; i < 3; i++)
      expect(
        ((await (await call(`/operations/${unknownId}/dispatch`, unknownDispatch)).json()) as any)
          .receipt.state,
      ).toBe("outcome-unknown");
    expect(calls.filter((c) => c.method === "POST").length).toBe(postsBeforeUnknown + 1);
    readbackOverride = null;
  } finally {
    await scratch.close();
  }

  // Scope: a read-only grant neither advertises nor reviews read-state changes.
  scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
  const callsBeforeScope = calls.length;
  expect((await provider.capabilities(owner)).readState).toBe(false);
  for (const kind of ["mark-read", "mark-unread"])
    await expect(
      provider.review(
        owner,
        { kind, messageId: "target", expectedHistoryId: history },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  expect(calls.length).toBe(callsBeforeScope);
}, 60000);
