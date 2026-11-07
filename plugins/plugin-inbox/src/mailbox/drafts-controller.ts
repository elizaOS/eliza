/**
 * Headless controller for account-bound local email drafts: compose, reply,
 * reply-all and forward, recipients, attachments, a shelf of set-aside drafts,
 * reviewed assistant suggestions, moving a new email to another From account,
 * provider-draft editing and cleanup after a provider-confirmed send.
 *
 * Drafts stay on the device in the host's compare-and-exchange storage
 * (encrypted on a phone), keyed by the owner and the exact Gmail grant, and are
 * never sent by this controller: Send and provider-draft saves go to the
 * reviewed effect controller. A stale or conflicting copy is never overwritten.
 *
 * Slot names (`inbox-drafts:v1:<owner>` and `inbox-drafts:v1:shelf:<sha256>`)
 * and record layouts are installed-data identifiers.
 */
import {
  attachmentBytes,
  checkOutgoingAttachments,
  type MailAttachmentReviewer,
  type OutgoingMailAttachment,
  outgoingAttachmentLimits,
} from "./attachments.ts";
import { sha256Hex } from "./digest.ts";
import type { InboxUnsaved } from "./retained-draft.ts";
import type { GmailMessage } from "./types.ts";

// biome-ignore lint/suspicious/noExplicitAny: proposals and composer events are host data validated here.
type Bag = Record<string, any>;

/** Content handed to a new composer: shared from another app or moved to another From account. */
export type ComposePrefill = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: OutgoingMailAttachment[];
  status?: string;
  /** Set for an email moved by the From switcher: a refusal is reported by the caller, which returns it. */
  moved?: boolean;
};

/** Source attachments a forward carries, bound to the selected message and its historyId. */
export type ForwardSource = {
  messageId: string;
  historyId: string;
  parts: { partId: string; name: string; mimeType: string; size: number }[];
};

export type LocalMailDraft = {
  version: 1;
  id: string;
  revision: string;
  owner: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  attachments?: OutgoingMailAttachment[];
  forward?: ForwardSource;
  provider?: { draftId: string; providerDigest: string };
  subject: string;
  body: string;
  mode?: "compose" | "reply" | "reply-all" | "forward";
  reply?: { messageId: string; threadId: string };
  /**
   * Set on a saved draft whose local draft was later sent with different text:
   * an earlier version of a sent email. It is kept, labelled, and reused only
   * after a confirmation.
   */
  earlierThanSent?: true;
};

/** The destination of a reviewed assistant suggestion, as shown to the user before inserting it. */
export type SuggestionTarget =
  | { ready: false; reason: string; token: string }
  | {
      ready: true;
      kind: "draft" | "reply" | "new";
      append: boolean;
      reply: boolean;
      subject: string;
      to: string[];
      from?: string;
      /** A draft that was set aside: it exists but its composer is not on screen. */
      aside?: boolean;
      /** A set-aside draft that is not a reply to the message on screen. */
      elsewhere?: boolean;
      /** Characters of suggestion text this destination can still take. */
      room: number;
      token: string;
    };

type Policy = { maximumOutgoing: number; maximumTotalBytes: number };

/** The account-scoped recovery copy of the email being edited (host-owned, durable). */
export interface RetainedMailEdits {
  readonly ready: Promise<unknown>;
  readonly available: boolean;
  /** The retained copy as stored, or null when there is none or it cannot be read. */
  peek(): InboxUnsaved | null;
  readonly conflict: boolean;
  readonly error: boolean;
  readonly status: string;
  edit(value: InboxUnsaved): void;
  resume(): void;
  replace(): void;
  retry(): unknown;
  clear(): Promise<void>;
  recover(current: unknown): void;
  retire(): void;
}

/** The signed-in managed-service identity the drafts belong to. */
export interface MailDraftsIdentity {
  /** The current Cloud session; absent when signed out. */
  sessionId?: string | null;
  account: {
    environment: string;
    userId: string;
    organizationId?: string | null;
    sessionId?: string | null;
  } | null;
}

/** Host file selection for an outgoing attachment. The bytes are reviewed before they join a draft. */
export interface MailAttachmentPicker {
  select(): Promise<{ status: string; selectionId?: string; name?: string }>;
  read(
    selectionId: string,
  ): Promise<OutgoingMailAttachment & { size: number; sha256: string }>;
  forget(selectionId: string): Promise<unknown>;
}

export interface MailDraftsProvider {
  prepare(
    proposal: Bag,
    source?: { draftId: string; savedRevision?: string },
  ): Promise<void>;
  capabilities(): {
    send: boolean;
    providerDrafts: boolean;
    from?: string;
    forwardAttachments?: boolean;
    attachmentPolicy?: Policy;
  } | null;
}

export interface MailDraftsControllerOptions {
  publish(): void;
  toast(text: string): void;
  provider?: MailDraftsProvider;
  identity(): MailDraftsIdentity;
  store: {
    read<T>(slot: string): Promise<T | null>;
    compareExchange(
      slot: string,
      expected: unknown,
      value: unknown,
    ): Promise<{ status: string }>;
  };
  /** Opens the recovery copy for one owner. `restore` applies a resumed copy. */
  retained(
    owner: string,
    publish: () => void,
    restore: (value: InboxUnsaved) => void,
  ): RetainedMailEdits;
  /** An explicit yes/no question. */
  confirm(message: string): boolean;
  attachments: MailAttachmentPicker;
  reviewAttachment: MailAttachmentReviewer;
}

const DRAFT_BYTES = 8 * 1024 * 1024;
const BODY_LIMIT = 64000;

const forwardValid = (f: unknown) => {
  if (f === undefined) return true;
  const value = f as ForwardSource | null;
  return (
    !!value &&
    typeof value.messageId === "string" &&
    typeof value.historyId === "string" &&
    Array.isArray(value.parts) &&
    value.parts.length <= outgoingAttachmentLimits.maximumFiles &&
    value.parts.every(
      (p) =>
        p &&
        typeof p.partId === "string" &&
        typeof p.name === "string" &&
        typeof p.mimeType === "string" &&
        typeof p.size === "number",
    )
  );
};

/** One literal address: no display names, lists or whitespace. */
export const literalMailAddress = (v: string): boolean =>
  v.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(v);

/** A saved local draft of this owner, within the composer bounds. */
export function validLocalMailDraft(
  v: unknown,
  owner: string,
): v is LocalMailDraft {
  const d = v as Bag | null;
  return (
    !!d &&
    d.version === 1 &&
    d.owner === owner &&
    typeof d.id === "string" &&
    typeof d.revision === "string" &&
    Array.isArray(d.to) &&
    d.to.length <= 20 &&
    d.to.every(
      (a: unknown) => typeof a === "string" && literalMailAddress(a),
    ) &&
    [d.cc || [], d.bcc || []].every(
      (list: unknown) =>
        Array.isArray(list) &&
        list.length <= 20 &&
        list.every((a) => typeof a === "string" && literalMailAddress(a)),
    ) &&
    typeof d.subject === "string" &&
    d.subject.length <= 998 &&
    !/[\r\n]/.test(d.subject) &&
    typeof d.body === "string" &&
    d.body.length <= BODY_LIMIT &&
    (!d.reply ||
      (typeof d.reply.messageId === "string" &&
        typeof d.reply.threadId === "string")) &&
    (d.attachments === undefined ||
      (Array.isArray(d.attachments) &&
        d.attachments.length <= outgoingAttachmentLimits.maximumFiles)) &&
    forwardValid(d.forward) &&
    (d.earlierThanSent === undefined || d.earlierThanSent === true)
  );
}

/** Local encrypted drafts remain separate from explicitly reviewed provider operations. */
export function createMailDraftsController(
  options: MailDraftsControllerOptions,
) {
  const { publish, toast, provider, store } = options;
  /** Servers without the multi-attachment policy accept one file. */
  const policy = (): Policy =>
    provider?.capabilities()?.attachmentPolicy || {
      maximumOutgoing: 1,
      maximumTotalBytes: outgoingAttachmentLimits.maximumTotalBytes,
    };
  const forwardProposal = (d: LocalMailDraft) =>
    d.forward?.parts.length
      ? {
          forwardAttachments: {
            messageId: d.forward.messageId,
            historyId: d.forward.historyId,
            partIds: d.forward.parts.map((p) => p.partId),
          },
        }
      : {};
  let reviewRevision = 0;
  let owner = "",
    account = "",
    session = "",
    epoch = 0,
    saved: LocalMailDraft | null = null,
    draft: LocalMailDraft | null = null;
  type Shelved = { draft: LocalMailDraft; toQ: string };
  type Shelf = { version: 1; owner: string; items: Shelved[] };
  let shelf: Shelf | null = null,
    shelfKey = "";
  const shelfSlot = () => `inbox-drafts:v1:shelf:${shelfKey}`;
  const shelfDraft = (d: LocalMailDraft) =>
    validLocalMailDraft({ ...d, to: [], cc: [], bcc: [] }, owner) &&
    [d.to, d.cc || [], d.bcc || []].every(
      (list) =>
        Array.isArray(list) &&
        list.length <= 20 &&
        list.every((a) => typeof a === "string" && a.length <= 254),
    );
  const shelfValid = (v: unknown): v is Shelf => {
    const value = v as Shelf | null;
    return (
      !!value &&
      value.version === 1 &&
      value.owner === owner &&
      Array.isArray(value.items) &&
      value.items.length <= 50 &&
      new Set(value.items.map((row: Shelved) => row?.draft?.id)).size ===
        value.items.length &&
      value.items.every(
        (row: Shelved) =>
          row &&
          shelfDraft(row.draft) &&
          typeof row.toQ === "string" &&
          row.toQ.length <= 4096,
      )
    );
  };

  async function saveShelf(next: Shelf) {
    const token = epoch,
      expected = shelf;
    const receipt = await store.compareExchange(shelfSlot(), expected, next);
    if (token !== epoch) throw Error("Draft account changed");
    if (receipt.status !== "saved")
      throw Error(
        "Drafts changed in another window. Reload before continuing.",
      );
    shelf = next;
  }

  const pendingEdits = new Map<
    string,
    {
      draft: LocalMailDraft;
      toQ: string;
      baseRevision: string | null;
      persist?: boolean;
    }
  >();
  let retained: RetainedMailEdits | null = null,
    baseRevision: string | null = null,
    staleBase = false;
  let loading = false,
    ready = false,
    busy = false,
    open = false,
    confirm = false,
    toQ = "",
    label = "",
    status = "",
    recipientDetails = false;
  let fromSwitch: { count(): number; cycle(): void } | null = null;
  /** A provider-confirmed send waiting for this account's local copies to load. */
  let sent: {
      draftId: string;
      proposal: Bag;
      account: string;
      savedRevision?: string;
    } | null = null,
    earlier = "";

  const slot = () => `inbox-drafts:v1:${owner}`;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  /** True only when a local copy holds exactly the content the provider confirmed as sent. */
  const sentContent = (d: Bag, p: Bag, withForward: boolean) =>
    (d.mode || (d.reply ? "reply" : "compose")) === p.mode &&
    same(d.to, p.to) &&
    same(d.cc || [], p.cc || []) &&
    same(d.bcc || [], p.bcc || []) &&
    d.subject === p.subject &&
    d.body === p.bodyText &&
    same(d.attachments || [], p.attachments || []) &&
    d.reply?.messageId === p.replyMessageId &&
    (!withForward ||
      same(
        forwardProposal(d as LocalMailDraft),
        p.forwardAttachments
          ? { forwardAttachments: p.forwardAttachments }
          : {},
      ));
  /**
   * The saved draft is an earlier version of a sent email (marked in storage,
   * or in this session when the mark could not be written).
   */
  const earlierVersion = () =>
    !!saved && (saved.earlierThanSent === true || saved.id === earlier);
  /** The saved draft as an editable copy; the earlier-version mark stays with the saved copy. */
  const fromSaved = () => {
    const { earlierThanSent: _earlier, ...copy } = structuredClone(
      saved as LocalMailDraft,
    );
    return copy as LocalMailDraft;
  };

  // The retained recovery record does not yet admit forwarded source
  // attachments, so its copy omits them; the explicitly saved local draft keeps them.
  function persist() {
    reviewRevision++;
    if (draft) {
      const { forward: _forward, ...copy } = structuredClone(draft);
      retained?.edit({ version: 1, owner, baseRevision, draft: copy, toQ });
    }
  }

  function restoreRetained(value: InboxUnsaved) {
    draft = structuredClone(value.draft) as LocalMailDraft;
    toQ = value.toQ;
    baseRevision = value.baseRevision;
    staleBase = baseRevision !== (saved?.revision || null);
    open = true;
    confirm = false;
    status = staleBase
      ? "The saved local draft changed. Review the latest saved copy before saving these edits."
      : draft?.mode === "forward"
        ? "Retained forward edits restored without any original attachments; forward the message again to include them. Review before provider actions."
        : "Retained email edits restored. Review before provider actions.";
    publish();
  }

  /**
   * Removes the local copies of the draft a confirmed send came from: the open
   * composer, the retained unsaved copy and the saved local draft. Each is
   * removed only when it is that draft (same id) and still holds exactly the
   * sent content; an edited or different copy is left alone. When any copy of
   * that draft was edited after the send, or a copy cannot be removed, the
   * remaining copies stay too, so the edits keep the saved draft they are based
   * on. Only the account the send came from is touched.
   */
  async function settleSent() {
    const target = sent;
    if (!target || !ready || busy) return;
    sent = null;
    if (target.account !== account) return;
    const { draftId, proposal, savedRevision } = target,
      token = epoch,
      key = slot();
    // An open or retained copy that was edited after the send is in use: nothing of it is removed.
    if (
      draft?.id === draftId &&
      (toQ.trim() || !sentContent(draft, proposal, true))
    )
      return;
    const kept = retained?.peek();
    if (
      kept &&
      kept.draft.id === draftId &&
      (kept.toQ.trim() || !sentContent(kept.draft, proposal, false))
    )
      return;
    // Retained edits that cannot be read are not known to be the sent content.
    if (retained?.available && !kept) return;
    busy = true;
    publish();
    let removed = false;
    try {
      if (draft?.id === draftId) {
        pendingEdits.delete(owner);
        draft = null;
        open = false;
        confirm = false;
        toQ = "";
        baseRevision = saved?.revision || null;
        staleBase = false;
        removed = true;
      }
      if (kept && kept.draft.id === draftId) {
        let cleared = false;
        try {
          await retained?.clear();
          cleared = true;
        } catch {}
        if (token !== epoch) return;
        if (!cleared) {
          status =
            "Sent. A retained copy of this email could not be removed from this device.";
          return;
        }
        removed = true;
      }
      if (shelf?.items.some((row) => row.draft.id === draftId)) {
        await saveShelf({
          ...shelf,
          items: shelf.items.flatMap((row) =>
            row.draft.id !== draftId
              ? [row]
              : !row.toQ.trim() && sentContent(row.draft, proposal, true)
                ? []
                : [{ ...row, draft: { ...row.draft, earlierThanSent: true } }],
          ),
        });
        if (token !== epoch) return;
      }
      const expected = saved;
      if (
        expected &&
        expected.id === draftId &&
        sentContent(expected, proposal, true)
      ) {
        try {
          const receipt = await store.compareExchange(key, expected, null);
          if (token !== epoch) return;
          if (receipt.status === "saved") {
            saved = null;
            baseRevision = null;
            removed = true;
          }
        } catch {}
        if (token !== epoch) return;
      } else if (
        expected &&
        expected.id === draftId &&
        savedRevision &&
        expected.revision === savedRevision
      ) {
        // The saved copy of the sent draft is the one that existed when Send
        // was reviewed and holds other text: an earlier version. It is never
        // removed automatically; it is labelled (in storage, so the label
        // survives a reload) and reusing it takes an explicit, confirmed
        // choice. A copy saved after that, here or in another window, is not
        // called an earlier version.
        earlier = draftId;
        if (!expected.earlierThanSent) {
          const marked: LocalMailDraft = { ...expected, earlierThanSent: true };
          try {
            const receipt = await store.compareExchange(key, expected, marked);
            if (token !== epoch) return;
            if (receipt.status === "saved") saved = marked;
          } catch {}
          if (token !== epoch) return;
        }
      }
      if (removed)
        status =
          saved?.id === draftId
            ? "Sent. The sent copy was removed from this device; an earlier saved version of this email is kept."
            : "Sent. The local copy of this email was removed from this device.";
    } finally {
      if (token === epoch) {
        busy = false;
        publish();
      }
    }
  }

  function reset() {
    sent = null;
    earlier = "";
    account = "";
    retained?.retire();
    retained = null;
    baseRevision = null;
    staleBase = false;
    pendingEdits.clear();
    shelf = null;
    shelfKey = "";
    epoch++;
    owner = "";
    session = "";
    saved = draft = null;
    loading = ready = busy = open = confirm = recipientDetails = false;
    toQ = "";
    status = "";
  }

  async function bind(account_: string, accountLabel: string) {
    const { account: identity, sessionId } = options.identity();
    const next =
      identity && sessionId === identity.sessionId && account_
        ? JSON.stringify([
            identity.environment,
            identity.userId,
            identity.organizationId || "",
            account_,
          ])
        : "";
    if (next === owner && sessionId === session && ready) return;
    if (draft)
      pendingEdits.set(owner, {
        draft: structuredClone(draft),
        toQ,
        baseRevision,
      });
    if (next !== owner) {
      sent = null;
      earlier = "";
    }
    retained?.retire();
    retained = null;
    baseRevision = null;
    staleBase = false;
    epoch++;
    saved = draft = null;
    loading = ready = busy = open = confirm = recipientDetails = false;
    toQ = "";
    status = "";
    owner = next;
    account = next ? account_ : "";
    session = sessionId || "";
    label = accountLabel;
    if (!owner) return;
    const token = epoch,
      key = slot();
    shelf = null;
    shelfKey = "";
    loading = true;
    status = "Checking local draft…";
    publish();
    try {
      const value = await store.read<LocalMailDraft>(key);
      if (token !== epoch) return;
      const hash = await sha256Hex(owner);
      if (token !== epoch) return;
      shelfKey = hash;
      const storedShelf = await store.read<Shelf>(shelfSlot());
      if (token !== epoch) return;
      if (storedShelf !== null && !shelfValid(storedShelf))
        throw Error("Saved drafts need recovery");
      shelf = storedShelf;
      if (value !== null && !validLocalMailDraft(value, owner)) throw Error();
      saved = value;
      const pending = pendingEdits.get(owner);
      draft = pending?.draft || null;
      toQ = pending?.toQ || "";
      baseRevision = pending ? pending.baseRevision : value?.revision || null;
      staleBase = !!pending && baseRevision !== (saved?.revision || null);
      const recovery = options.retained(owner, publish, (restored) => {
        if (token === epoch) restoreRetained(restored);
      });
      retained = recovery;
      await recovery.ready;
      if (token !== epoch) return;
      ready = true;
      if (pending?.persist) {
        pendingEdits.set(owner, { ...pending, persist: false });
        persist();
      }
      status = draft
        ? "Edits retained for this account"
        : value
          ? "Saved draft on this device"
          : "No saved local draft";
    } catch {
      if (token === epoch)
        status = "Local draft storage unavailable. Retry connection to reload.";
    }
    if (token === epoch) {
      loading = false;
      publish();
      void settleSent();
    }
  }

  /** Persist the current email before replacing its composer; no provider operation runs. */
  async function setAside(): Promise<boolean> {
    if (!ready || busy) return false;
    if (retained?.error || retained?.conflict || staleBase) {
      toast(
        "Reload the saved draft before starting another email. Your edits are retained.",
      );
      return false;
    }
    const kept = retained?.peek();
    if (retained?.available && !kept) {
      toast("Recover the retained draft before starting another email.");
      return false;
    }
    const meaningful = (row: Shelved) =>
      !!(
        row.toQ.trim() ||
        row.draft.to.length ||
        row.draft.cc?.length ||
        row.draft.bcc?.length ||
        row.draft.subject.trim() ||
        row.draft.body.trim() ||
        row.draft.attachments?.length ||
        row.draft.forward?.parts.length
      );
    const copies = new Map<string, Shelved>();
    for (const row of shelf?.items || []) copies.set(row.draft.id, row);
    if (saved) copies.set(saved.id, { draft: structuredClone(saved), toQ: "" });
    if (kept)
      copies.set(kept.draft.id, {
        draft: structuredClone(kept.draft) as LocalMailDraft,
        toQ: kept.toQ,
      });
    if (draft) copies.set(draft.id, { draft: structuredClone(draft), toQ });
    if (!saved && !kept && !draft) return true;
    const next: Shelf = {
      version: 1,
      owner,
      items: [...copies.values()].filter(meaningful),
    };
    if (
      !shelfValid(next) ||
      new TextEncoder().encode(JSON.stringify(next)).length > DRAFT_BYTES
    ) {
      toast("Draft storage is full. Your current email is still here.");
      return false;
    }
    const token = epoch;
    busy = true;
    publish();
    try {
      await saveShelf(next);
      if (token !== epoch) return false;
      if (saved) {
        const receipt = await store.compareExchange(slot(), saved, null);
        if (token !== epoch) return false;
        if (receipt.status !== "saved")
          throw Error("The saved draft changed. Reload before continuing.");
        saved = null;
      }
      await retained?.clear();
      if (token !== epoch) return false;
      pendingEdits.delete(owner);
      draft = null;
      open = false;
      confirm = false;
      baseRevision = null;
      staleBase = false;
      toQ = "";
      status = "Draft saved";
      return true;
    } catch (error) {
      if (token === epoch)
        toast(
          error instanceof Error
            ? error.message
            : "The draft could not be saved. Your edits remain here.",
        );
      return false;
    } finally {
      if (token === epoch) {
        busy = false;
        publish();
      }
    }
  }

  function begin(
    reply?: GmailMessage,
    mode: "reply" | "reply-all" | "forward" = "reply",
    forwardedBody = "",
    prefill?: ComposePrefill,
    extra: { body?: string; forward?: ForwardSource | null } = {},
  ): boolean {
    if (!ready || busy) {
      toast(status || "Connect a Gmail account first.");
      return false;
    }
    const refuse = (text: string) => {
      if (!prefill?.moved) toast(text);
      return false;
    };
    if (draft) {
      if (prefill)
        return refuse(
          "Finish, save or discard the open email draft first. The shared content was not added.",
        );
      open = true;
      confirm = false;
      publish();
      return true;
    }
    if (retained?.available)
      return refuse(
        prefill
          ? "Resume the retained email edits first. The shared content was not added."
          : "Open Drafts to continue or discard your unfinished email before creating another.",
      );
    if (saved)
      return refuse(
        prefill
          ? "Restore or discard the saved local draft first. The shared content was not added."
          : "Open Drafts to continue or discard your saved draft before creating another.",
      );
    if (prefill && !reply) {
      const clean = (list: unknown) =>
        Array.isArray(list)
          ? [
              ...new Set(
                list
                  .filter(
                    (a): a is string =>
                      typeof a === "string" && literalMailAddress(a.trim()),
                  )
                  .map((a) => a.trim()),
              ),
            ].slice(0, 20)
          : [];
      draft = {
        version: 1,
        id: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        owner,
        mode: "compose",
        to: clean(prefill.to),
        cc: clean(prefill.cc),
        bcc: clean(prefill.bcc),
        subject: String(prefill.subject || "")
          .replace(/[\r\n]+/g, " ")
          .slice(0, 998),
        body: String(prefill.body || "").slice(0, BODY_LIMIT),
        ...(prefill.attachments?.length
          ? {
              attachments: structuredClone(
                prefill.attachments.slice(
                  0,
                  outgoingAttachmentLimits.maximumFiles,
                ),
              ),
            }
          : {}),
      };
      baseRevision = null;
      staleBase = false;
      open = true;
      confirm = false;
      toQ = "";
      persist();
      status =
        prefill.status ||
        "Unsaved local draft. Review before sending; nothing has been sent.";
      publish();
      return true;
    }
    if (
      reply &&
      mode !== "forward" &&
      !literalMailAddress(reply.replyTo || reply.fromEmail || "")
    ) {
      toast("This message has no valid literal reply address.");
      return false;
    }
    const self = provider?.capabilities()?.from?.toLowerCase(),
      primary = reply ? reply.replyTo || reply.fromEmail || "" : "";
    const to =
      reply && mode !== "forward"
        ? [
            ...new Set([primary, ...(mode === "reply-all" ? reply.to : [])]),
          ].filter((a) => a.toLowerCase() !== self)
        : [];
    const cc =
      mode === "reply-all"
        ? [...new Set(reply?.cc || [])].filter(
            (a) =>
              a.toLowerCase() !== self &&
              !to.some((t) => t.toLowerCase() === a.toLowerCase()),
          )
        : [];
    if ([...to, ...cc].some((a) => !literalMailAddress(a))) {
      toast(
        "A reply recipient is ambiguous. Compose with explicitly reviewed literal addresses instead.",
      );
      return false;
    }
    // Source attachments are forwarded only when the server binds them to this message's historyId.
    const source =
      reply &&
      mode === "forward" &&
      extra.forward &&
      extra.forward.messageId === reply.id &&
      extra.forward.parts.length &&
      provider?.capabilities()?.forwardAttachments
        ? {
            messageId: extra.forward.messageId,
            historyId: extra.forward.historyId,
            parts: extra.forward.parts
              .slice(0, outgoingAttachmentLimits.maximumFiles)
              .map((p) => ({
                partId: p.partId,
                name: p.name,
                mimeType: p.mimeType,
                size: p.size,
              })),
          }
        : null;
    const initial =
      typeof extra.body === "string" ? extra.body.slice(0, BODY_LIMIT) : "";
    draft = {
      version: 1,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      owner,
      mode: reply ? mode : "compose",
      to,
      cc,
      bcc: [],
      subject:
        reply && mode === "forward"
          ? `Fwd: ${reply.subject}`.slice(0, 998)
          : reply
            ? (/^re:/i.test(reply.subject)
                ? reply.subject
                : `Re: ${reply.subject}`
              ).slice(0, 998)
            : "",
      body:
        reply && mode === "forward"
          ? `${initial}\n\nForwarded message from ${reply.from}\nSubject: ${reply.subject}\n\n${forwardedBody}`
          : initial,
      ...(reply && mode !== "forward"
        ? { reply: { messageId: reply.id, threadId: reply.threadId } }
        : {}),
      ...(source ? { forward: source } : {}),
    };
    baseRevision = null;
    staleBase = false;
    open = true;
    confirm = false;
    toQ = "";
    persist();
    status =
      mode === "forward" && reply
        ? source
          ? `Forwarding ${source.parts.length} original attachment${source.parts.length === 1 ? "" : "s"} from the selected message. Remove any you do not want to send; nothing has been sent.`
          : extra.forward?.parts.length
            ? "Forwarded text only. This account cannot forward the original attachments here; add a supported file explicitly."
            : "Forwarded text only. The original message has no attachments."
        : initial
          ? "Agent suggestion placed in a local draft. Review and edit before sending; nothing has been sent."
          : "Unsaved local draft";
    publish();
    return true;
  }

  async function newEmail(
    reply?: GmailMessage,
    mode: "reply" | "reply-all" | "forward" = "reply",
    forwardedBody = "",
    extra: { body?: string; forward?: ForwardSource | null } = {},
  ) {
    if (!owner) {
      toast("Connect a Gmail account first.");
      return false;
    }
    if (!ready || busy) {
      toast(status || "Wait for drafts to load.");
      return false;
    }
    if (
      reply &&
      mode !== "forward" &&
      draft?.reply?.messageId === reply.id &&
      draft.reply.threadId === reply.threadId &&
      (draft.mode || "reply") === mode
    )
      return begin();
    const token = epoch,
      target = reply ? structuredClone(reply) : undefined,
      copied = structuredClone(extra);
    if (!(await setAside()) || token !== epoch) return false;
    return begin(target, mode, forwardedBody, undefined, copied);
  }

  /** A share starts a separate email after preserving the previous local work. */
  async function newSharedEmail(
    prefill: ComposePrefill,
    current: () => boolean,
  ) {
    if (!current()) return false;
    if (!owner) {
      toast("Connect a Gmail account first.");
      return false;
    }
    if (!ready || busy) {
      toast(status || "Wait for drafts to load.");
      return false;
    }
    const token = epoch,
      target = structuredClone(prefill);
    if (!(await setAside()) || token !== epoch || !current()) return false;
    return begin(undefined, undefined, "", target);
  }

  async function openShelved(id: string) {
    const row = shelf?.items.find((item) => item.draft.id === id);
    if (!row || !ready || busy) return;
    if (
      row.draft.earlierThanSent &&
      !options.confirm(
        "This is an earlier version of a sent email. Open it for editing? Sending it creates another message.",
      )
    )
      return;
    const token = epoch;
    if (!(await setAside()) || token !== epoch) return;
    draft = structuredClone(row.draft);
    toQ = row.toQ;
    baseRevision = null;
    staleBase = false;
    open = true;
    confirm = false;
    status = "Draft on this device";
    persist();
    publish();
  }

  /**
   * Moves an open new email out of this account so it can continue under
   * another From account. Replies and provider drafts belong to their mailbox
   * and are never moved.
   */
  async function transfer(): Promise<
    (ComposePrefill & { savedRemains: boolean; restore: () => void }) | null
  > {
    if (!draft || busy) return null;
    if (
      draft.reply ||
      draft.provider ||
      (draft.mode && draft.mode !== "compose")
    ) {
      toast(
        "Replies, forwards and Gmail drafts stay with the account they came from.",
      );
      return null;
    }
    if (toQ.trim()) {
      toast(
        "Add or clear the address you are typing before changing the From account.",
      );
      return null;
    }
    const from = owner,
      kept = { draft: structuredClone(draft), toQ: "", baseRevision };
    // If the other account cannot take it, the email goes back here: rebinding
    // this owner reopens it from memory and writes a fresh recovery copy, so it
    // is never silently lost.
    const restore = () => {
      pendingEdits.set(from, { ...structuredClone(kept), persist: true });
    };
    const content = {
      to: [...draft.to],
      cc: [...(draft.cc || [])],
      bcc: [...(draft.bcc || [])],
      subject: draft.subject,
      body: draft.body,
      attachments: structuredClone(draft.attachments || []),
      savedRemains: !!saved,
      restore,
    };
    const token = epoch;
    try {
      await retained?.clear();
    } catch {
      if (token === epoch)
        toast(
          "Retained email edits changed. Review recovery before changing the From account.",
        );
      return null;
    }
    if (token !== epoch) return null;
    pendingEdits.delete(owner);
    draft = null;
    open = false;
    confirm = false;
    baseRevision = null;
    staleBase = false;
    toQ = "";
    publish();
    return content;
  }

  function add() {
    if (!draft || busy) return;
    const value = toQ.trim();
    if (!literalMailAddress(value) || draft.to.length >= 20) {
      toast("Enter one literal email address, up to 20 recipients.");
      return;
    }
    if (!draft.to.includes(value)) draft.to.push(value);
    toQ = "";
    status = "Unsaved local draft";
    persist();
    publish();
  }

  async function update(remove = false) {
    if (!draft || !ready || busy) return;
    if (staleBase) {
      toast(
        "The saved local draft changed. Review the latest saved copy before saving these edits.",
      );
      return;
    }
    if (!remove && toQ.trim()) {
      add();
      if (toQ.trim()) return;
    }
    const value = remove
      ? null
      : { ...draft, revision: crypto.randomUUID(), to: [...draft.to] };
    if (
      value &&
      (!validLocalMailDraft(value, owner) ||
        new TextEncoder().encode(JSON.stringify(value)).length > DRAFT_BYTES)
    ) {
      toast("Draft is too large or contains an invalid subject.");
      return;
    }
    const token = epoch,
      key = slot(),
      expected = saved;
    busy = true;
    publish();
    try {
      const receipt = await store.compareExchange(key, expected, value);
      if (token !== epoch) return;
      if (receipt.status !== "saved") {
        status =
          "Draft changed in another window. Close this composer and reload before replacing it.";
        ready = false;
        toast(status);
        return;
      }
      pendingEdits.delete(owner);
      saved = value;
      earlier = "";
      let cleared = true;
      // The composer email at this point (busy blocks edits; a resumed copy may have replaced it).
      const currentId = (draft as LocalMailDraft).id;
      if (shelf?.items.some((row) => row.draft.id === currentId)) {
        try {
          await saveShelf({
            ...shelf,
            items: shelf.items.filter((row) => row.draft.id !== currentId),
          });
        } catch {
          cleared = false;
        }
        if (token !== epoch) return;
      }
      try {
        await retained?.clear();
      } catch {
        cleared = false;
      }
      if (token !== epoch) return;
      baseRevision = value?.revision || null;
      staleBase = false;
      draft = value ? structuredClone(value) : cleared ? null : draft;
      status = cleared
        ? remove
          ? "Local draft discarded"
          : "Saved locally on this device"
        : remove
          ? "Saved local draft removed; retained edits could not be cleared. Review recovery before closing."
          : "Saved locally; retained edits could not be cleared. Review recovery before closing.";
      confirm = false;
      if (remove && cleared) open = false;
      toast(status);
    } catch {
      if (token === epoch) {
        status = "Local draft update failed. Your edits remain here.";
        toast(status);
      }
    } finally {
      if (token === epoch) {
        busy = false;
        publish();
        void settleSent();
      }
    }
  }

  async function attach() {
    if (!draft || busy) return;
    if (
      (draft.attachments?.length || 0) >=
      Math.min(policy().maximumOutgoing, outgoingAttachmentLimits.maximumFiles)
    ) {
      toast(
        policy().maximumOutgoing === 1
          ? "This account accepts one attachment per email. Remove it to choose another."
          : `Attach at most ${outgoingAttachmentLimits.maximumFiles} files.`,
      );
      return;
    }
    const token = epoch;
    let selectionId: string | undefined;
    busy = true;
    publish();
    try {
      const selected = await options.attachments.select();
      selectionId = selected.selectionId;
      if (token !== epoch) return;
      if (selected.status === "cancelled") return;
      if (
        selected.status !== "selected" ||
        !selected.selectionId ||
        !selected.name
      )
        throw new Error("Select one supported document or image");
      const file = await options.attachments.read(selected.selectionId);
      const checked = await options.reviewAttachment(file);
      if (checked.sha256 !== file.sha256 || checked.size !== file.size)
        throw new Error("Selected file changed");
      if (token !== epoch || !draft) return;
      const next = [
        ...(draft.attachments || []),
        {
          name: file.name,
          mimeType: file.mimeType,
          dataBase64: file.dataBase64,
        },
      ];
      checkOutgoingAttachments(next, policy());
      if (
        draft.forward &&
        next.length + draft.forward.parts.length >
          outgoingAttachmentLimits.maximumFiles
      )
        throw new Error(
          `Attach at most ${outgoingAttachmentLimits.maximumFiles} files including forwarded ones.`,
        );
      draft.attachments = next;
      status = `${next.length} attachment${next.length === 1 ? "" : "s"} selected locally. Nothing uploaded until provider review.`;
      persist();
    } catch (error) {
      if (token === epoch)
        toast(
          error instanceof Error ? error.message : "Attachment unavailable",
        );
    } finally {
      if (selectionId)
        await options.attachments.forget(selectionId).catch(() => {});
      if (token === epoch) {
        busy = false;
        publish();
        void settleSent();
      }
    }
  }

  function edit(key: "subject" | "body", value: string) {
    if (draft && !busy) {
      draft[key] = value;
      status = "Unsaved local draft";
      persist();
      publish();
    }
  }

  /**
   * Where a suggestion would land right now, for review before anything is
   * inserted. The token identifies the account owner and the exact draft
   * content or message; it never leaves the host.
   */
  function suggestionTarget(reply?: GmailMessage): SuggestionTarget {
    const blocked = (reason: string): SuggestionTarget => ({
      ready: false,
      reason,
      token: JSON.stringify([owner, "blocked", reason]),
    });
    if (options.identity().sessionId !== session)
      return blocked(
        "Open Inbox to refresh the selected account first. Nothing was added.",
      );
    if (!owner || !ready || busy)
      return blocked(
        loading || busy
          ? "The local email draft is still loading. Try again in a moment."
          : status || "Connect a Gmail account first.",
      );
    if (draft) {
      const recipients = [
        ...draft.to,
        ...(draft.cc || []),
        ...(draft.bcc || []),
      ];
      const append = !!draft.body.trim();
      // One draft exists per account. When its composer is closed the user may
      // be looking at another message, so the review says that this draft is
      // not on screen and is not a reply to that message.
      const aside = !open,
        elsewhere = aside && !!reply && draft.reply?.messageId !== reply.id;
      return {
        ready: true,
        kind: "draft",
        append,
        aside,
        elsewhere,
        reply:
          !!draft.reply || draft.mode === "reply" || draft.mode === "reply-all",
        subject: draft.subject,
        to: recipients,
        room: append
          ? Math.max(0, BODY_LIMIT - draft.body.replace(/\s+$/, "").length - 2)
          : BODY_LIMIT,
        token: JSON.stringify([
          owner,
          "draft",
          draft.id,
          draft.mode || "",
          draft.reply?.messageId || "",
          draft.provider?.draftId || "",
          draft.subject,
          draft.to,
          draft.cc || [],
          draft.bcc || [],
          draft.body,
          draft.revision,
          reviewRevision,
          draft.forward || null,
          toQ,
          aside,
          elsewhere,
        ]),
      };
    }
    if (retained?.available)
      return blocked(
        "Resume the retained email edits in Inbox first. The suggestion was not added.",
      );
    if (saved)
      return blocked(
        "Restore or discard the saved local draft in Inbox first. The suggestion was not added.",
      );
    if (reply) {
      const primary = reply.replyTo || reply.fromEmail || "";
      if (!literalMailAddress(primary))
        return blocked("This message has no valid literal reply address.");
      // The recipients `begin` gives a reply: the literal reply address, never the account's own address.
      const self = provider?.capabilities()?.from?.toLowerCase(),
        to = [primary].filter((a) => a.toLowerCase() !== self);
      return {
        ready: true,
        kind: "reply",
        append: false,
        reply: true,
        subject: (/^re:/i.test(reply.subject)
          ? reply.subject
          : `Re: ${reply.subject}`
        ).slice(0, 998),
        to,
        from: reply.from,
        room: BODY_LIMIT,
        token: JSON.stringify([
          owner,
          "reply",
          reply.id,
          reply.threadId,
          to,
          reply.subject,
        ]),
      };
    }
    return {
      ready: true,
      kind: "new",
      append: false,
      reply: false,
      subject: "",
      to: [],
      room: BODY_LIMIT,
      token: JSON.stringify([owner, "new"]),
    };
  }

  const composeProposal = (d: LocalMailDraft) => ({
    mode: d.mode || (d.reply ? "reply" : "compose"),
    to: [...d.to],
    cc: [...(d.cc || [])],
    bcc: [...(d.bcc || [])],
    subject: d.subject,
    bodyText: d.body,
    attachments: [...(d.attachments || [])],
    ...forwardProposal(d),
    ...(d.reply ? { replyMessageId: d.reply.messageId } : {}),
  });

  const controller = {
    bind,
    reset,
    begin,
    newEmail,
    newSharedEmail,
    transfer,
    /** An explicit Files review adds exact bytes to this account's draft, never a provider operation. */
    attachReviewed(file: OutgoingMailAttachment, expected: string): boolean {
      const target = suggestionTarget();
      if (!target.ready || target.token !== expected) return false;
      const existing = draft?.attachments || [];
      if (existing.some((item) => item.dataBase64 === file.dataBase64)) {
        toast("This file is already attached. Nothing was added.");
        return false;
      }
      const next = [
        ...existing,
        {
          name: file.name,
          mimeType: file.mimeType,
          dataBase64: file.dataBase64,
        },
      ];
      try {
        checkOutgoingAttachments(next, policy());
        if (
          next.length + (draft?.forward?.parts.length || 0) >
          outgoingAttachmentLimits.maximumFiles
        )
          throw Error("Too many attachments.");
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "Attachment unavailable",
        );
        return false;
      }
      if (!draft && !begin()) return false;
      (draft as LocalMailDraft).attachments = next;
      open = true;
      confirm = false;
      status =
        "Selected file added to this local draft. Review recipients, text and attachments before sending; nothing has been sent.";
      persist();
      publish();
      return true;
    },
    /**
     * "Use in email": agent text becomes a local draft for the selected message
     * (a reply) or a new email, under the selected account. It is never sent;
     * the composer and provider review still apply. With `expected` (the
     * assistant review), the destination must still be the one that was
     * reviewed, and `append` adds the text below what the open draft already
     * holds. Existing text is never replaced.
     */
    useSuggestion(
      text: string,
      reply?: GmailMessage,
      expected?: { token: string; append?: boolean },
    ): boolean {
      const body = String(text || "").slice(0, BODY_LIMIT);
      if (!body.trim()) {
        toast("The suggestion is empty.");
        return false;
      }
      if (!ready || busy) {
        toast(status || "Connect a Gmail account first.");
        return false;
      }
      // A reviewed suggestion is inserted whole or not at all; only the legacy call shortens it.
      if (
        expected &&
        (String(text).length > BODY_LIMIT ||
          suggestionTarget(reply).token !== expected.token)
      )
        return false;
      if (draft) {
        if (draft.body.trim()) {
          if (!expected?.append) {
            toast(
              "Finish, save or discard the open email draft first. The suggestion was not added.",
            );
            return false;
          }
          const joined = `${draft.body.replace(/\s+$/, "")}\n\n${body}`;
          if (joined.length > BODY_LIMIT) {
            toast(
              "The draft would be too long with this suggestion. Nothing was added.",
            );
            return false;
          }
          draft.body = joined;
          open = true;
          confirm = false;
          status =
            "Agent suggestion added below your text. Review and edit before sending; nothing has been sent.";
          persist();
          publish();
          return true;
        }
        draft.body = body;
        open = true;
        confirm = false;
        status =
          "Agent suggestion placed in the open draft. Review and edit before sending; nothing has been sent.";
        persist();
        publish();
        return true;
      }
      if (reply) return begin(reply, "reply", "", undefined, { body });
      return begin(undefined, "reply", "", {
        to: [],
        subject: "",
        body,
        status:
          "Agent suggestion placed in a local draft. Review and edit before sending; nothing has been sent.",
      });
    },
    suggestionTarget,
    setFromSwitch(value: typeof fromSwitch) {
      fromSwitch = value;
    },
    get ready() {
      return ready && !busy;
    },
    get hasDraft() {
      return !!draft;
    },
    async editProvider(
      proposal: Bag,
      reference: { draftId: string; providerDigest: string },
    ) {
      if (retained?.available && !draft) {
        toast(
          "Resume retained email edits before editing another provider draft.",
        );
        return false;
      }
      if (!ready || busy) {
        toast("Local draft storage unavailable");
        return false;
      }
      if (
        draft &&
        (draft.body !== proposal.bodyText ||
          draft.subject !== proposal.subject ||
          JSON.stringify(draft.to) !== JSON.stringify(proposal.to) ||
          JSON.stringify(draft.cc || []) !==
            JSON.stringify(proposal.cc || []) ||
          JSON.stringify(draft.bcc || []) !==
            JSON.stringify(proposal.bcc || []) ||
          JSON.stringify(draft.attachments || []) !==
            JSON.stringify(proposal.attachments || []))
      )
        return false;
      draft = {
        version: 1,
        id: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        owner,
        to: [...proposal.to],
        cc: [...(proposal.cc || [])],
        bcc: [...(proposal.bcc || [])],
        subject: proposal.subject,
        body: proposal.bodyText,
        mode: proposal.mode,
        attachments: proposal.attachments || [],
        provider: reference,
        ...(proposal.replyMessageId
          ? { reply: { messageId: proposal.replyMessageId, threadId: "" } }
          : {}),
      };
      baseRevision = saved?.revision || null;
      staleBase = false;
      open = true;
      confirm = false;
      status =
        "Editing provider draft. Save locally to preserve edits. Gmail replacement is not atomic.";
      publish();
      await update();
      return (
        saved?.provider?.draftId === reference.draftId &&
        saved?.provider?.providerDigest === reference.providerDigest
      );
    },
    close() {
      if (!open) return false;
      if (busy) {
        toast("Wait for the local draft update.");
        return true;
      }
      open = false;
      confirm = false;
      if (status === "Unsaved local draft")
        toast(retained?.status || "Edits remain in this session.");
      publish();
      return true;
    },
    /** The email now in the composer, in the shape Send reviews. A review of anything else is stale. */
    proposal(): Bag | null {
      return draft ? composeProposal(draft) : null;
    },
    /**
     * That email with the identity of its local draft. A moved email is a new
     * draft under the other From account, so the identity also names the account.
     */
    email(): { draftId: string; proposal: Bag } | null {
      const proposal = controller.proposal();
      return draft && proposal ? { draftId: draft.id, proposal } : null;
    },
    chips<T extends Bag>(
      chip: (label: string, action: () => void) => T,
    ): Bag[] {
      const local = draft || retained?.peek?.()?.draft || saved;
      return ready
        ? [
            ...(draft
              ? [
                  chip("Continue draft", () => {
                    open = true;
                    publish();
                  }),
                ]
              : retained?.available
                ? [chip("Resume unsaved email", () => retained?.resume())]
                : saved
                  ? [
                      chip(
                        earlierVersion()
                          ? "Earlier version of a sent email"
                          : "Restore local draft",
                        () => {
                          const reuse = earlierVersion();
                          if (
                            reuse &&
                            !options.confirm(
                              "This saved draft is an earlier version of an email that was already sent.\n\nOpen it to edit or send? Sending it creates another message.",
                            )
                          )
                            return;
                          draft = fromSaved();
                          baseRevision = (saved as LocalMailDraft).revision;
                          staleBase = false;
                          open = true;
                          confirm = false;
                          toQ = "";
                          if (reuse)
                            status =
                              "Earlier version of a sent email. Sending it creates another message; nothing has been sent.";
                          publish();
                        },
                      ),
                    ]
                  : []),
            ...(shelf?.items
              .filter((row) => row.draft.id !== local?.id)
              .map((row) => ({
                ...chip(
                  "Open local draft",
                  () => void openShelved(row.draft.id),
                ),
                subject: row.draft.subject || "(No subject)",
                snippet: row.draft.body.slice(0, 160) || "Draft on this device",
              })) || []),
            ...(retained?.error
              ? [chip("Recover email edits", () => retained?.recover(draft))]
              : []),
          ].map((row: Bag) => ({
            ...row,
            subject: row.subject || local?.subject || "(No subject)",
            snippet:
              row.snippet ||
              local?.body?.slice(0, 160) ||
              "Draft on this device",
            recovery: row.label === "Recover email edits",
          }))
        : [];
    },
    /** Called for a provider-confirmed send that recorded its source draft; safe to repeat. */
    settleSent(
      draftId: string,
      proposal: Bag,
      grant: string,
      savedRevision?: string,
    ) {
      if (!grant || grant !== account) return Promise.resolve();
      sent = {
        draftId,
        proposal: structuredClone(proposal),
        account: grant,
        ...(savedRevision ? { savedRevision } : {}),
      };
      return settleSent();
    },
    /** What the receipt may say about local copies of the sent draft. */
    sentNote(draftId: string) {
      if (!ready || busy || sent)
        return "Checking the local copy of this email on this device.";
      if (
        shelf?.items.some(
          (row) => row.draft.id === draftId && row.draft.earlierThanSent,
        ) ||
        (draft?.id !== draftId &&
          retained?.peek()?.draft.id !== draftId &&
          saved?.id === draftId &&
          earlierVersion())
      )
        return "An earlier saved version of this email is still on this device. It is kept until you discard it; sending it creates another message.";
      return draft?.id === draftId ||
        retained?.peek()?.draft.id === draftId ||
        saved?.id === draftId ||
        shelf?.items.some((row) => row.draft.id === draftId)
        ? "A local copy of this email is still on this device because it was edited after sending or could not be removed. Sending it creates another message."
        : "The local draft and unsaved copy of this sent email were removed from this device.";
    },
    render() {
      const current = draft;
      const caps = provider?.capabilities();
      return {
        composeDisabled: !ready || loading || busy,
        composing: open && !!current,
        c: current
          ? {
              local: true,
              status,
              busy,
              confirm,
              recoveryVisible: !!retained?.error || !!retained?.conflict,
              sendDisabled: busy || !caps?.send,
              showSendHint: !!caps && !caps.send,
              heading:
                current.mode === "reply-all"
                  ? "Reply all"
                  : current.mode === "reply"
                    ? "Reply"
                    : current.mode === "forward"
                      ? "Forward"
                      : "New message",
              showRecipientDetails:
                recipientDetails ||
                !!current.cc?.length ||
                !!current.bcc?.length,
              toggleRecipientDetails: () => {
                recipientDetails = !recipientDetails;
                publish();
              },
              retainedStatus: retained?.status,
              retainedConflict: retained?.conflict,
              retainedError: retained?.error,
              restoreEdits: () => retained?.resume(),
              replaceEdits: () => {
                if (
                  options.confirm(
                    "Replace the retained email edits with this composer?",
                  )
                )
                  retained?.replace();
              },
              retryEdits: () => void retained?.retry(),
              recoverEdits: () => retained?.recover({ draft, toQ }),
              staleBase,
              useLatest: async () => {
                if (
                  !options.confirm(
                    "Discard these edits and review the latest saved local draft?",
                  )
                )
                  return;
                const token = epoch;
                try {
                  await retained?.clear();
                  if (token !== epoch) return;
                  draft = saved ? fromSaved() : null;
                  toQ = "";
                  baseRevision = saved?.revision || null;
                  staleBase = false;
                  open = !!draft;
                  status = "Review the latest saved local draft.";
                  publish();
                } catch {
                  if (token === epoch)
                    toast(
                      "Retained edits changed. Review recovery before discarding them.",
                    );
                }
              },
              save: () => void update(),
              discard: () => {
                if (!busy) {
                  confirm = true;
                  publish();
                }
              },
              cancelDiscard: () => {
                confirm = false;
                publish();
              },
              confirmDiscard: () => void update(true),
              send: () => {
                if (!provider?.capabilities()?.send) {
                  toast(
                    "Sending is unavailable for this account. Save locally; no email has been sent.",
                  );
                  return;
                }
                if (toQ.trim()) {
                  add();
                  if (toQ.trim()) return;
                }
                const sending = draft as LocalMailDraft;
                void provider.prepare(
                  { kind: "send", ...composeProposal(sending) },
                  {
                    draftId: sending.id,
                    ...(saved?.id === sending.id
                      ? { savedRevision: saved.revision }
                      : {}),
                  },
                );
              },
              canSaveProvider: !!caps?.providerDrafts,
              saveProvider: () => {
                if (toQ.trim()) {
                  add();
                  if (toQ.trim()) return;
                }
                const saving = draft as LocalMailDraft;
                void provider?.prepare(
                  {
                    kind: saving.provider ? "draft-replace" : "draft-create",
                    ...(saving.provider
                      ? {
                          draftId: saving.provider.draftId,
                          expectedDigest: saving.provider.providerDigest,
                          acceptNonAtomicReplacement: true,
                        }
                      : {}),
                    ...composeProposal(saving),
                  },
                  { draftId: saving.id },
                );
              },
              singleFrom: (fromSwitch?.count() || 0) <= 1,
              multi: (fromSwitch?.count() || 0) > 1,
              from: label ? `From ${label}` : "",
              cycleFrom: () => {
                if (busy) return;
                if (fromSwitch && fromSwitch.count() > 1) fromSwitch.cycle();
                else toast("Only one Gmail account is connected.");
              },
              chips: current.to.map((name) => ({
                name,
                rm: () => {
                  if (!busy && draft) {
                    draft.to = draft.to.filter((a) => a !== name);
                    status = "Unsaved local draft";
                    persist();
                    publish();
                  }
                },
              })),
              toQ,
              toPh: "Email address",
              onTo: (e: Bag) => {
                if (!busy) {
                  toQ = String(e.target.value);
                  status = "Unsaved local draft";
                  persist();
                  publish();
                }
              },
              toKey: (e: Bag) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              },
              hasRaw: !!toQ.trim(),
              rawAddr: toQ.trim(),
              addRaw: add,
              hasSugg: false,
              sugg: [],
              cc: (current.cc || []).join(", "),
              bcc: (current.bcc || []).join(", "),
              onCc: (e: Bag) => {
                if (!busy && draft) {
                  draft.cc = String(e.target.value)
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean);
                  status = "Unsaved local draft";
                  persist();
                  publish();
                }
              },
              onBcc: (e: Bag) => {
                if (!busy && draft) {
                  draft.bcc = String(e.target.value)
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean);
                  status = "Unsaved local draft";
                  persist();
                  publish();
                }
              },
              subject: current.subject,
              body: current.body,
              onSubj: (e: Bag) => edit("subject", String(e.target.value)),
              onBody: (e: Bag) => edit("body", String(e.target.value)),
              hasAtts:
                !!current.attachments?.length ||
                !!current.forward?.parts.length,
              // Each file is removed on its own; forwarded originals are listed and removable the same way.
              atts: [
                ...(current.attachments || []).map((a, index) => ({
                  name: a.name,
                  size: `${a.mimeType} · ${attachmentBytes(a).toLocaleString()} bytes`,
                  forwarded: false,
                  rm: () => {
                    if (busy || !draft) return;
                    const list = draft.attachments || [];
                    if (list[index] !== a) return;
                    draft.attachments = list.filter((_, i) => i !== index);
                    status = "Unsaved local draft";
                    persist();
                    publish();
                  },
                })),
                ...(current.forward?.parts || []).map((part) => ({
                  name: `${part.name} (original)`,
                  forwarded: true,
                  rm: () => {
                    if (busy || !draft?.forward) return;
                    draft.forward = {
                      ...draft.forward,
                      parts: draft.forward.parts.filter(
                        (p) => p.partId !== part.partId,
                      ),
                    };
                    status = "Unsaved local draft";
                    persist();
                    publish();
                  },
                })),
              ],
              attachLabel: "Attach file",
              attachmentHint: `PDF, images or text · up to ${policy().maximumOutgoing} file${policy().maximumOutgoing === 1 ? "" : "s"}, ${Math.floor(policy().maximumTotalBytes / (1024 * 1024))} MiB total`,
              attach: () => void attach(),
            }
          : null,
      };
    },
  };
  return controller;
}

export type MailDraftsController = ReturnType<
  typeof createMailDraftsController
>;
