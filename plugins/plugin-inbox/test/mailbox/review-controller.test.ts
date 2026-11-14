/**
 * The reviewed managed-Gmail effect controller against an in-memory store and a
 * synthetic provider: exact composer binding, single dispatch, unknown outcomes,
 * reviewed Undo, withdrawn grants and account changes. No account or network.
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/mailbox/digest.ts";
import {
  createMailReviewController,
  type MailReviewBinding,
  type MailReviewClient,
  type MailReviewControllerOptions,
} from "../../src/mailbox/review-controller.ts";
import type {
  GmailInboxCapabilities,
  GmailInboxReceipt,
} from "../../src/mailbox/types.ts";

type Bag = Record<string, unknown>;

const caps: GmailInboxCapabilities = {
  version: 1,
  from: "owner@example.invalid",
  threads: true,
  send: true,
  providerDrafts: true,
  mailboxMutations: true,
  attachments: true,
  providerExactlyOnce: false,
  atomicDraftReplacement: false,
  readState: true,
  draftsList: true,
  forwardAttachments: false,
  searchTrash: false,
  opaqueAttachments: false,
  attachmentPolicy: {
    maximumOutgoing: 1,
    maximumBytes: 5242880,
    maximumTotalBytes: 5242880,
  },
};

function fixture(
  outcome: GmailInboxReceipt["state"] = "succeeded",
  granted: Partial<GmailInboxCapabilities> = {},
  extra: Partial<MailReviewControllerOptions> = {},
) {
  const slots = new Map<string, string>();
  const receipts = new Map<string, GmailInboxReceipt>();
  const dispatched: Bag[] = [];
  const toasts: string[] = [];
  let state = { outcome, publishes: 0 };
  const hooks: {
    prepareGate?: Promise<void>;
    failReads?: boolean;
    prepareError?: unknown;
    capabilitiesError?: boolean;
  } = {};
  const client: MailReviewClient = {
    gmailInboxCapabilities: async () => {
      if (hooks.capabilitiesError) throw new Error("capabilities unavailable");
      return { ...caps, ...granted };
    },
    gmailDraft: async (_grant, draftId) => ({
      draftId,
      messageId: "m",
      providerDigest: "d".repeat(64),
    }),
    async gmailPrepareOperation(_grant, requestId, proposal) {
      await hooks.prepareGate;
      if (hooks.prepareError) throw hooks.prepareError;
      const review = {
        ...proposal,
        from: "owner@example.invalid",
        attachments: [],
      };
      const receipt: GmailInboxReceipt = {
        requestId,
        kind: proposal.kind as GmailInboxReceipt["kind"],
        state: "prepared",
        reviewDigest: await sha256Hex(JSON.stringify(review)),
        providerResult: null,
        rejectionCode: null,
      };
      receipts.set(requestId, receipt);
      return { receipt, review };
    },
    async gmailDispatchOperation(_grant, requestId, reviewDigest, proposal) {
      dispatched.push(proposal);
      const kind = proposal.kind as GmailInboxReceipt["kind"];
      const receipt: GmailInboxReceipt = {
        requestId,
        kind,
        state: state.outcome,
        reviewDigest,
        providerResult:
          state.outcome === "succeeded"
            ? kind === "send"
              ? { messageId: "sent-1" }
              : { messageId: proposal.messageId, historyId: "h2" }
            : null,
        rejectionCode: null,
      };
      receipts.set(requestId, receipt);
      return receipt;
    },
    async gmailOperation(_grant, requestId) {
      const receipt = receipts.get(requestId);
      if (!receipt) throw new Error("unknown");
      return receipt;
    },
  };
  let current: MailReviewBinding | null = {
    client,
    sessionId: "session-1",
    owner: JSON.stringify(["production", "user", "org"]),
  };
  const controller = createMailReviewController({
    publish: () => {
      state.publishes++;
    },
    toast: (message) => toasts.push(message),
    binding: () => current,
    store: {
      async read<T>(key: string) {
        if (hooks.failReads) throw new Error("storage unavailable");
        const raw = slots.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as T);
      },
      async compareExchange(key: string, expected: unknown, value: unknown) {
        if ((slots.get(key) ?? "null") !== JSON.stringify(expected))
          return { status: "conflict" };
        if (value === null) slots.delete(key);
        else slots.set(key, JSON.stringify(value));
        return { status: "saved" };
      },
    },
    reviewAttachment: async () => {
      throw new Error("no attachments in this fixture");
    },
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    defer: (task) => task(),
    ...extra,
  });
  return {
    controller,
    hooks,
    slots,
    dispatched,
    toasts,
    setOutcome(next: GmailInboxReceipt["state"]) {
      state = { ...state, outcome: next };
    },
    signOut() {
      current = null;
    },
  };
}

/** The phone client's Cloud protocol error, as the controller receives it. */
class CloudProtocolError extends Error {
  readonly code = "http";
  constructor(
    readonly status: number,
    readonly data?: unknown,
  ) {
    super(`Cloud http (${status})`);
    this.name = "CloudProtocolError";
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const email = (body = "Hello"): Bag => ({
  kind: "send",
  mode: "compose",
  to: ["friend@example.invalid"],
  subject: "S",
  bodyText: body,
});

describe("createMailReviewController", () => {
  it("dispatches a send once, only for the exact reviewed composer email", async () => {
    const f = fixture();
    let composerEmail = { draftId: "draft-1", proposal: email() };
    f.controller.setComposer(() => composerEmail);
    const sent: string[] = [];
    f.controller.setObservers({
      sent: (source) => sent.push(source.draftId),
    });
    await f.controller.bind("grant");
    await f.controller.prepare(email(), { draftId: "draft-1" });
    let view = f.controller.render();
    expect(view.providerReview).toBe(true);
    expect(view.provider.canConfirm).toBe(true);
    expect(view.provider.to).toBe("friend@example.invalid");
    // An edit after review discards it without dispatch.
    composerEmail = { draftId: "draft-1", proposal: email("Edited") };
    view = f.controller.render();
    await settle();
    expect(f.toasts.at(-1)).toMatch(/edited after this review/);
    expect(f.dispatched).toEqual([]);
    composerEmail = { draftId: "draft-1", proposal: email("Edited") };
    await f.controller.prepare(email("Edited"), { draftId: "draft-1" });
    f.controller.render().provider.confirm();
    await settle();
    expect(f.dispatched).toHaveLength(1);
    expect(f.controller.render().provider.status).toBe(
      "Provider confirmed this operation.",
    );
    expect(sent).toEqual(["draft-1"]);
  });

  it("shows an unknown outcome as uncertain and never re-enables Send", async () => {
    const f = fixture("outcome-unknown");
    const composerEmail = { draftId: "d", proposal: email() };
    f.controller.setComposer(() => composerEmail);
    await f.controller.bind("grant");
    await f.controller.prepare(email(), { draftId: "d" });
    f.controller.render().provider.confirm();
    await settle();
    const view = f.controller.render().provider;
    expect(view.status).toMatch(/Delivery outcome is unknown/);
    expect(view.canConfirm).toBe(false);
    expect(view.canClear).toBe(false);
    view.confirm();
    await settle();
    expect(f.dispatched).toHaveLength(1);
  });

  it("offers a reviewed Undo after a confirmed trash", async () => {
    const f = fixture();
    let restored = 0;
    f.controller.onRestored(() => restored++);
    await f.controller.bind("grant");
    await f.controller.prepare({
      kind: "trash",
      messageId: "m1",
      expectedHistoryId: "h1",
    });
    f.controller.render().provider.confirm();
    await settle();
    const after = f.controller.render().provider;
    expect(after.canUndo).toBe(true);
    after.undo();
    await settle();
    const undo = f.controller.render().provider;
    expect(undo.title).toBe("Restore from Trash");
    expect(undo.canConfirm).toBe(true);
    expect(f.dispatched).toHaveLength(1);
    undo.confirm();
    await settle();
    expect(f.dispatched.map((p) => p.kind)).toEqual(["trash", "untrash"]);
    expect(restored).toBe(1);
  });

  it("refuses actions the account has not granted", async () => {
    const f = fixture("succeeded", { mailboxMutations: false });
    await f.controller.bind("grant");
    await f.controller.prepare({
      kind: "trash",
      messageId: "m1",
      expectedHistoryId: "h1",
    });
    expect(f.toasts.at(-1)).toMatch(/has not allowed Gmail changes/);
    expect(f.slots.size).toBe(0);
  });

  it("discards an undispatched review when change access is withdrawn", async () => {
    const f = fixture();
    await f.controller.bind("grant");
    await f.controller.prepare({
      kind: "archive",
      messageId: "m1",
      expectedHistoryId: "h1",
    });
    expect(f.slots.size).toBe(1);
    f.controller.withdrawn();
    await settle();
    expect(f.slots.size).toBe(0);
    expect(f.toasts.at(-1)).toMatch(/change access was withdrawn/);
    expect(f.dispatched).toEqual([]);
  });

  it("tells the owner when a withdrawal applied by a reset cannot discard the review", async () => {
    const f = fixture();
    await f.controller.bind("grant");
    let release = () => {};
    f.hooks.prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparing = f.controller.prepare({
      kind: "archive",
      messageId: "m1",
      expectedHistoryId: "h1",
    });
    await settle();
    // The withdrawal waits for the active run; the reset then owns it.
    f.controller.withdrawn();
    f.controller.reset();
    f.hooks.failReads = true;
    release();
    await preparing.catch(() => {});
    await settle();
    expect(f.toasts.at(-1)).toMatch(
      /withdrawn, but the unsent review could not be discarded/,
    );
    expect(f.dispatched).toEqual([]);
  });

  it("shows Cloud's refusal instead of the transport error", async () => {
    const cases: Array<[CloudProtocolError, string | RegExp]> = [
      [
        new CloudProtocolError(400, {
          error: "Attachment names must be unique",
        }),
        "Attachment names must be unique",
      ],
      [
        new CloudProtocolError(413),
        "Gmail refused this change. Check the review and try again.",
      ],
      [
        new CloudProtocolError(400, { error: "See https://x.invalid/help" }),
        "Gmail refused this change. Check the review and try again.",
      ],
      [new CloudProtocolError(502), /Mail operation unavailable/],
    ];
    for (const [error, shown] of cases) {
      const f = fixture();
      await f.controller.bind("grant");
      f.hooks.prepareError = error;
      await f.controller.prepare({
        kind: "archive",
        messageId: "m1",
        expectedHistoryId: "h1",
      });
      if (typeof shown === "string") expect(f.toasts.at(-1)).toBe(shown);
      else expect(f.toasts.at(-1)).toMatch(shown);
      expect(f.controller.render().provider.status).not.toMatch(/Cloud http/);
      expect(f.controller.render().provider.canRetry).toBe(true);
      expect(f.dispatched).toEqual([]);
    }
  });

  it("asks for sign-in again when the host reports the session expired", async () => {
    const calls: Array<[string, unknown]> = [];
    const f = fixture(
      "succeeded",
      {},
      {
        onSessionError: (sessionId, error) => {
          calls.push([sessionId, error]);
          return true;
        },
      },
    );
    await f.controller.bind("grant");
    const expired = new CloudProtocolError(401);
    f.hooks.prepareError = expired;
    await f.controller.prepare({
      kind: "archive",
      messageId: "m1",
      expectedHistoryId: "h1",
    });
    expect(calls).toEqual([["session-1", expired]]);
    expect(f.controller.render().provider.status).toBe(
      "Cloud sign-in expired. Sign in again, then check this review before retrying.",
    );
    expect(f.dispatched).toEqual([]);
  });

  it("reports a failed capability read apart from a missing grant", async () => {
    const f = fixture();
    f.hooks.capabilitiesError = true;
    await f.controller.bind("grant");
    expect(f.controller.render().capabilitiesFailed).toBe(true);
    f.hooks.capabilitiesError = false;
    await f.controller.bind("grant");
    expect(f.controller.render().capabilitiesFailed).toBe(false);
    f.hooks.capabilitiesError = true;
    await f.controller.bind("grant");
    expect(f.controller.render().capabilitiesFailed).toBe(true);
  });

  it("offers a reviewed permanent delete of the Gmail draft a sent email came from", async () => {
    const f = fixture();
    const providerDraft = { draftId: "g1", providerDigest: "e".repeat(64) };
    const composerEmail = { draftId: "local-1", proposal: email() };
    f.controller.setComposer(() => composerEmail);
    const notes: Array<Bag> = [];
    f.controller.setObservers({
      sentNote: (source) => {
        notes.push(source);
        return source.providerDraft
          ? "Sent. The Gmail draft you opened is still in Drafts."
          : "Sent.";
      },
    });
    await f.controller.bind("grant");
    await f.controller.prepare(email(), { draftId: "local-1", providerDraft });
    f.controller.render().provider.confirm();
    await settle();
    let view = f.controller.render().provider;
    expect(f.dispatched.map((p) => p.kind)).toEqual(["send"]);
    expect(view.draftNote).toBe(
      "Sent. The Gmail draft you opened is still in Drafts.",
    );
    expect(notes.at(-1)?.providerDraft).toEqual(providerDraft);
    expect(view.canDeleteDraft).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    view.deleteDraft();
    await settle();
    view = f.controller.render().provider;
    expect(view.title).toBe("Delete Gmail draft");
    expect(view.deletionWarning).toBe(true);
    expect(view.confirmLabel).toBe("Permanently delete draft");
    // Nothing is deleted until the permanent delete is confirmed.
    expect(f.dispatched).toHaveLength(1);
    view.confirm();
    await settle();
    expect(f.dispatched.at(-1)).toEqual({
      kind: "draft-delete",
      draftId: "g1",
      expectedDigest: providerDraft.providerDigest,
      confirmPermanentDelete: true,
    });
  });

  it("does not offer a Gmail draft delete after sending a local-only email", async () => {
    const f = fixture();
    const composerEmail = { draftId: "local-1", proposal: email() };
    f.controller.setComposer(() => composerEmail);
    await f.controller.bind("grant");
    await f.controller.prepare(email(), { draftId: "local-1" });
    f.controller.render().provider.confirm();
    await settle();
    expect(f.controller.render().provider.canDeleteDraft).toBe(false);
  });

  it("stops at an account change before dispatch", async () => {
    const f = fixture();
    await f.controller.bind("grant");
    await f.controller.prepare({
      kind: "archive",
      messageId: "m1",
      expectedHistoryId: "h1",
    });
    f.signOut();
    f.controller.render().provider.confirm();
    await settle();
    expect(f.dispatched).toEqual([]);
  });
});
