/**
 * Account-bound local email drafts against in-memory storage, a synthetic
 * recovery copy and a recording provider. No account, network or mail.
 */
import { describe, expect, it } from "vitest";
import {
  createMailDraftsController,
  literalMailAddress,
  type MailDraftsProvider,
  type RetainedMailEdits,
  validLocalMailDraft,
} from "../../src/mailbox/drafts-controller.ts";
import {
  encodeInboxUnsaved,
  type InboxUnsaved,
} from "../../src/mailbox/retained-draft.ts";

type Bag = Record<string, unknown>;

function fixture(
  caps: ReturnType<MailDraftsProvider["capabilities"]> = {
    send: true,
    providerDrafts: true,
    from: "owner@example.invalid",
  },
) {
  const slots = new Map<string, string>();
  const retainedCopies = new Map<string, InboxUnsaved>();
  const toasts: string[] = [];
  const prepared: Array<{ proposal: Bag; source?: Bag }> = [];
  let sessionId = "session-1";
  const store = {
    async read<T>(slot: string) {
      const raw = slots.get(slot);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async compareExchange(slot: string, expected: unknown, value: unknown) {
      if ((slots.get(slot) ?? "null") !== JSON.stringify(expected))
        return { status: "conflict" };
      if (value === null) slots.delete(slot);
      else slots.set(slot, JSON.stringify(value));
      return { status: "saved" };
    },
  };
  const retained = (
    owner: string,
    _publish: () => void,
    restore: (value: InboxUnsaved) => void,
  ): RetainedMailEdits => ({
    ready: Promise.resolve(),
    get available() {
      return retainedCopies.has(owner);
    },
    peek: () => structuredClone(retainedCopies.get(owner) ?? null),
    conflict: false,
    error: false,
    status: "",
    edit(value) {
      // The host stores only a copy its own validation accepts.
      encodeInboxUnsaved(value);
      retainedCopies.set(owner, structuredClone(value));
    },
    resume() {
      const value = retainedCopies.get(owner);
      if (value) restore(structuredClone(value));
    },
    replace() {},
    retry() {},
    async clear() {
      retainedCopies.delete(owner);
    },
    recover() {},
    retire() {},
  });
  const controller = createMailDraftsController({
    publish() {},
    toast: (text) => toasts.push(text),
    provider: {
      prepare: async (proposal, source) => {
        prepared.push({ proposal, source });
      },
      capabilities: () => caps,
    },
    identity: () => ({
      sessionId,
      account: {
        environment: "production",
        userId: "user",
        organizationId: "org",
        sessionId,
      },
    }),
    store,
    retained,
    confirm: () => true,
    attachments: {
      select: async () => ({ status: "cancelled" }),
      read: async () => {
        throw new Error("unused");
      },
      forget: async () => {},
    },
    reviewAttachment: async () => {
      throw new Error("unused");
    },
  });
  return {
    controller,
    slots,
    retainedCopies,
    toasts,
    prepared,
    switchSession(next: string) {
      sessionId = next;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const MiB = 1024 * 1024;
const base64 = (bytes: number) => "A".repeat(Math.ceil(bytes / 3) * 4);
const save = async (controller: ReturnType<typeof fixture>["controller"]) => {
  (controller.render().c as { save: () => void }).save();
  await settle();
};
const shelfItems = (f: ReturnType<typeof fixture>) => {
  const key = [...f.slots.keys()].find((k) => k.includes(":shelf:"));
  return key
    ? (JSON.parse(f.slots.get(key) as string).items as Array<{
        draft: Bag;
      }>)
    : [];
};
const gmailDraft = {
  mode: "compose",
  to: ["friend@example.invalid"],
  cc: [],
  bcc: [],
  subject: "From Gmail",
  bodyText: "Gmail text",
  attachments: [],
};

const message = {
  id: "m1",
  threadId: "t1",
  subject: "Plans",
  from: "Sender",
  fromEmail: "sender@example.invalid",
  replyTo: "reply@example.invalid",
  to: ["owner@example.invalid", "teammate@example.invalid"],
  cc: ["copy@example.invalid"],
  snippet: "",
  receivedAt: "2026-10-27T00:00:00Z",
  unread: false,
};
const type = (
  controller: ReturnType<typeof fixture>["controller"],
  key: "onSubj" | "onBody" | "onTo" | "onCc" | "onBcc",
  value: string,
) => {
  const composer = controller.render().c as Record<string, unknown>;
  (composer[key] as (event: { target: { value: string } }) => void)({
    target: { value },
  });
};

describe("createMailDraftsController", () => {
  it("validates literal addresses and owner-bound records", () => {
    expect(literalMailAddress("a@example.invalid")).toBe(true);
    expect(literalMailAddress("Name <a@example.invalid>")).toBe(false);
    expect(
      validLocalMailDraft(
        {
          version: 1,
          id: "d",
          revision: "r",
          owner: "o",
          to: ["a@example.invalid"],
          subject: "S",
          body: "",
        },
        "o",
      ),
    ).toBe(true);
    expect(
      validLocalMailDraft(
        {
          version: 1,
          id: "d",
          revision: "r",
          owner: "x",
          to: [],
          subject: "S",
          body: "",
        },
        "o",
      ),
    ).toBe(false);
    expect(
      validLocalMailDraft(
        {
          version: 1,
          id: "d",
          revision: "r",
          owner: "o",
          to: [],
          subject: "a\nb",
          body: "",
        },
        "o",
      ),
    ).toBe(false);
  });

  it("composes a reply-all without the account's own address and sends only through review", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    expect(await f.controller.newEmail(message, "reply-all")).toBe(true);
    const proposal = f.controller.proposal() as Bag;
    expect(proposal.to).toEqual([
      "reply@example.invalid",
      "teammate@example.invalid",
    ]);
    expect(proposal.cc).toEqual(["copy@example.invalid"]);
    expect(proposal.replyMessageId).toBe("m1");
    type(f.controller, "onBody", "Sounds good");
    (f.controller.render().c as { send: () => void }).send();
    expect(f.prepared).toHaveLength(1);
    expect(f.prepared[0]?.proposal.kind).toBe("send");
    expect(f.prepared[0]?.source?.draftId).toBe(f.controller.email()?.draftId);
  });

  it("saves locally under the owner and grant and isolates other grants", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail();
    type(f.controller, "onSubj", "Kept here");
    type(f.controller, "onTo", "friend@example.invalid");
    (f.controller.render().c as { save: () => void }).save();
    await new Promise((r) => setTimeout(r, 0));
    const slot = [...f.slots.keys()].find((key) => !key.includes(":shelf:"));
    expect(slot).toBe(
      `inbox-drafts:v1:${JSON.stringify(["production", "user", "org", "grant-a"])}`,
    );
    expect(JSON.parse(f.slots.get(slot as string) as string).to).toEqual([
      "friend@example.invalid",
    ]);
    await f.controller.bind("grant-b", "other@example.invalid");
    expect(f.controller.chips((label, action) => ({ label, action }))).toEqual(
      [],
    );
    expect(f.prepared).toEqual([]);
  });

  it("sets an unfinished email aside on the shelf before starting another", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail();
    type(f.controller, "onSubj", "First");
    type(f.controller, "onBody", "Unfinished");
    f.controller.close();
    expect(await f.controller.newEmail()).toBe(true);
    const chips = f.controller.chips((label, action) => ({ label, action }));
    expect(chips.some((row) => row.subject === "First")).toBe(true);
    expect(
      [...f.slots.keys()].some((key) =>
        key.startsWith("inbox-drafts:v1:shelf:"),
      ),
    ).toBe(true);
  });

  it("removes only the exact sent local copy after a confirmed send", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail();
    type(f.controller, "onTo", "friend@example.invalid");
    type(f.controller, "onSubj", "Sent one");
    type(f.controller, "onBody", "Body");
    (f.controller.render().c as { save: () => void }).save();
    await new Promise((r) => setTimeout(r, 0));
    const email = f.controller.email();
    expect(email).not.toBeNull();
    await f.controller.settleSent(
      email?.draftId as string,
      { kind: "send", ...(email?.proposal as Bag) },
      "grant-a",
    );
    expect(f.controller.hasDraft).toBe(false);
    expect(f.controller.sentNote(email?.draftId as string)).toBe("Sent.");
    // A send confirmed for another grant never touches this account's drafts.
    await f.controller.newEmail();
    type(f.controller, "onSubj", "Other");
    const other = f.controller.email();
    await f.controller.settleSent(
      other?.draftId as string,
      other?.proposal as Bag,
      "grant-b",
    );
    expect(f.controller.hasDraft).toBe(true);
  });

  it("inserts a reviewed suggestion only at the reviewed destination and never replaces text", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    const target = f.controller.suggestionTarget(message);
    expect(target.ready && target.kind).toBe("reply");
    expect(
      f.controller.useSuggestion("Suggested reply", message, {
        token: target.token,
      }),
    ).toBe(true);
    expect((f.controller.proposal() as Bag).bodyText).toBe("Suggested reply");
    const stale = target.token;
    expect(f.controller.useSuggestion("Again", message, { token: stale })).toBe(
      false,
    );
    const draftTarget = f.controller.suggestionTarget(message);
    expect(
      f.controller.useSuggestion("More", message, {
        token: draftTarget.token,
        append: true,
      }),
    ).toBe(true);
    expect((f.controller.proposal() as Bag).bodyText).toBe(
      "Suggested reply\n\nMore",
    );
    f.switchSession("session-2");
    expect(f.controller.suggestionTarget(message).ready).toBe(false);
  });

  it("refuses a reply without a literal reply address and keeps Send off when the account cannot send", async () => {
    const f = fixture({ send: false, providerDrafts: false });
    await f.controller.bind("grant-a", "owner@example.invalid");
    expect(
      await f.controller.newEmail({
        ...message,
        replyTo: null,
        fromEmail: "Not an address",
      }),
    ).toBe(false);
    expect(f.toasts.at(-1)).toMatch(/no reply address/);
    await f.controller.newEmail();
    const composer = f.controller.render().c as {
      sendDisabled: boolean;
      send: () => void;
    };
    expect(composer.sendDisabled).toBe(true);
    composer.send();
    expect(f.prepared).toEqual([]);
    expect(f.toasts.at(-1)).toMatch(/Sending is unavailable/);
  });
  it("keeps a saved local draft when a Gmail draft is opened after relaunch", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail();
    type(f.controller, "onSubj", "Local only");
    type(f.controller, "onBody", "Local text");
    await save(f.controller);
    f.controller.reset();
    await f.controller.bind("grant-a", "owner@example.invalid");
    expect(f.controller.hasDraft).toBe(false);
    const reference = { draftId: "g1", providerDigest: "d1" };
    expect(await f.controller.editProvider(gmailDraft, reference)).toBe(true);
    expect((f.controller.proposal() as Bag).subject).toBe("From Gmail");
    expect(shelfItems(f).map((row) => row.draft.subject)).toEqual([
      "Local only",
    ]);

    // Newer local text saved for the same Gmail draft is what reopens.
    type(f.controller, "onBody", "Newer local text");
    await save(f.controller);
    f.controller.reset();
    await f.controller.bind("grant-a", "owner@example.invalid");
    expect(await f.controller.editProvider(gmailDraft, reference)).toBe(true);
    expect((f.controller.proposal() as Bag).bodyText).toBe("Newer local text");
    expect(shelfItems(f)).toHaveLength(1);

    // Edit from review with that copy open leaves no second shelf copy.
    expect(
      await f.controller.editProvider(
        { ...gmailDraft, bodyText: "Newer local text" },
        reference,
      ),
    ).toBe(true);
    expect(shelfItems(f)).toHaveLength(1);
  });

  it("warns when the saved copy of a Gmail draft is an earlier version of a sent email", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    const reference = { draftId: "g1", providerDigest: "d1" };
    expect(await f.controller.editProvider(gmailDraft, reference)).toBe(true);
    type(f.controller, "onBody", "Sent text");
    const email = f.controller.email();
    const revision = (
      JSON.parse(
        [...f.slots.entries()].find(
          ([k]) => !k.includes(":shelf:"),
        )?.[1] as string,
      ) as { revision: string }
    ).revision;
    await f.controller.settleSent(
      email?.draftId as string,
      { kind: "send", ...(email?.proposal as Bag) },
      "grant-a",
      revision,
      true,
    );
    f.controller.reset();
    await f.controller.bind("grant-a", "owner@example.invalid");
    expect(await f.controller.editProvider(gmailDraft, reference)).toBe(true);
    expect((f.controller.proposal() as Bag).bodyText).toBe("Gmail text");
    expect((f.controller.render().c as Bag).status).toMatch(
      /^Earlier version of a sent email/,
    );
  });

  it("refuses to open a Gmail draft over an open composer with other text", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail();
    type(f.controller, "onBody", "Typing here");
    expect(
      await f.controller.editProvider(gmailDraft, {
        draftId: "g1",
        providerDigest: "d1",
      }),
    ).toBe(false);
    expect((f.controller.proposal() as Bag).bodyText).toBe("Typing here");
  });

  it("keeps commas and spaces typed in Cc and Bcc", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail();
    for (const [key, field] of [
      ["onCc", "cc"],
      ["onBcc", "bcc"],
    ] as const) {
      type(f.controller, key, "a@b.c, ");
      expect((f.controller.render().c as Bag)[field]).toBe("a@b.c, ");
      type(f.controller, key, "a@b.c, d@e.f");
      expect((f.controller.proposal() as Bag)[field]).toEqual([
        "a@b.c",
        "d@e.f",
      ]);
    }
    expect(f.retainedCopies.values().next().value?.draft.cc).toEqual([
      "a@b.c",
      "d@e.f",
    ]);
  });

  it("reopens a shelved earlier version of a sent email with a valid recovery copy", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail();
    type(f.controller, "onTo", "friend@example.invalid");
    type(f.controller, "onSubj", "Earlier");
    type(f.controller, "onBody", "First text");
    const email = f.controller.email();
    f.controller.close();
    expect(await f.controller.newEmail()).toBe(true);
    await f.controller.settleSent(
      email?.draftId as string,
      { ...(email?.proposal as Bag), bodyText: "Sent text" },
      "grant-a",
    );
    expect(shelfItems(f)[0]?.draft.earlierThanSent).toBe(true);
    const chip = f.controller
      .chips((label, action) => ({ label, action }))
      .find((row) => row.subject === "Earlier");
    expect(chip).toBeDefined();
    (chip as { action: () => void }).action();
    await settle();
    expect((f.controller.proposal() as Bag).bodyText).toBe("First text");
    const kept = f.retainedCopies.values().next().value;
    expect(kept?.draft.id).toBe(email?.draftId);
    expect(kept?.draft.earlierThanSent).toBeUndefined();
    expect(shelfItems(f)[0]?.draft.earlierThanSent).toBe(true);
  });

  it("counts forwarded attachments toward the size cap and name check", async () => {
    const f = fixture({
      send: true,
      providerDrafts: true,
      from: "owner@example.invalid",
      forwardAttachments: true,
      attachmentPolicy: { maximumOutgoing: 10, maximumTotalBytes: 5 * MiB },
    });
    await f.controller.bind("grant-a", "owner@example.invalid");
    expect(
      await f.controller.newEmail(message, "forward", "", {
        forward: {
          messageId: "m1",
          historyId: "h1",
          parts: [
            {
              partId: "p1",
              name: "report.pdf",
              mimeType: "application/pdf",
              size: 3 * MiB,
            },
          ],
        },
      }),
    ).toBe(true);
    const attach = (name: string, bytes: number) =>
      f.controller.attachReviewed(
        { name, mimeType: "application/pdf", dataBase64: base64(bytes) },
        f.controller.suggestionTarget().token as string,
      );
    expect(attach("notes.pdf", 3 * MiB)).toBe(false);
    expect(f.toasts.at(-1)).toMatch(/exceed 5 MiB in total/);
    expect(attach("Report.pdf", 1024)).toBe(false);
    expect(f.toasts.at(-1)).toMatch(/same name/);
    expect(attach("notes.pdf", 1024)).toBe(true);
  });

  it("blocks Send when no recipient is left after removing the account's own address", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    expect(
      await f.controller.newEmail({
        ...message,
        replyTo: "owner@example.invalid",
      }),
    ).toBe(true);
    expect((f.controller.proposal() as Bag).to).toEqual([]);
    (f.controller.render().c as { send: () => void }).send();
    expect(f.prepared).toEqual([]);
    expect(f.toasts.at(-1)).toBe("Add a recipient before sending.");
  });

  it("sends an opened Gmail draft without deleting it and says it is still in Drafts", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    const reference = { draftId: "g1", providerDigest: "d1" };
    expect(await f.controller.editProvider(gmailDraft, reference)).toBe(true);
    (f.controller.render().c as { send: () => void }).send();
    expect(f.prepared).toHaveLength(1);
    expect(f.prepared[0]?.proposal.kind).toBe("send");
    expect(f.prepared[0]?.source?.providerDraft).toEqual(reference);
    const email = f.controller.email();
    await f.controller.settleSent(
      email?.draftId as string,
      { kind: "send", ...(email?.proposal as Bag) },
      "grant-a",
      undefined,
      true,
    );
    expect(f.controller.hasDraft).toBe(false);
    expect(f.controller.sentNote(email?.draftId as string, true)).toBe(
      "Sent. The Gmail draft you opened is still in Drafts.",
    );
    // Only the reviewed send went to Cloud: no draft deletion rides along.
    expect(f.prepared.map((row) => row.proposal.kind)).toEqual(["send"]);
  });

  it("keeps a reply's subject as Gmail threads it", async () => {
    const f = fixture();
    await f.controller.bind("grant-a", "owner@example.invalid");
    await f.controller.newEmail(message, "reply");
    type(f.controller, "onSubj", "Something else");
    expect((f.controller.proposal() as Bag).subject).toBe("Re: Plans");
    expect((f.controller.render().c as Bag).subjectReadOnly).toBe(true);
    await f.controller.newEmail({
      ...message,
      id: "m2",
      subject: "(no subject)",
    });
    expect((f.controller.proposal() as Bag).subject).toBe("Re: (no subject)");
  });
});
