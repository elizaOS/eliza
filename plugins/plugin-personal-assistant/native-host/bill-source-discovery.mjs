import { createHash } from "node:crypto";
import { readBillAttachments } from "./bill-attachment-reader.mjs";
import { gmailSourceLink } from "./bill-source-link.mjs";
import { BillHostError } from "./errors.mjs";

/** Fixed read-failure reasons. The renderer can say what to do next. */
export const BILL_SOURCE_FAILURE_REASONS = Object.freeze([
  "reauth_required",
  "cloud_sign_in_required",
  "insufficient_scope",
  "account_changed",
  "account_mismatch",
  "unavailable",
  "timeout",
]);
const unavailable = (reason = "unavailable") =>
  Object.assign(
    new BillHostError(
      "Bill sources are unavailable. Recheck the connected account and task.",
    ),
    { code: "BILL_SOURCES_UNAVAILABLE", reason },
  );
// Only a typed read-port code passes through; provider text never does.
const failureReason = (error) =>
  BILL_SOURCE_FAILURE_REASONS.includes(error?.reason)
    ? error.reason
    : BILL_SOURCE_FAILURE_REASONS.includes(error?.code)
      ? error.code
      : "unavailable";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (v, max = 300) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
const email = (v) => text(v, 320) && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v);
const date = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
function scope(input) {
  const c = structuredClone(input);
  if (
    !c ||
    ![
      "accountId",
      "actorId",
      "agentId",
      "taskId",
      "billingAccountRef",
      "company",
      "accountLabel",
    ].every((key) => text(c[key])) ||
    !Number.isSafeInteger(c.epoch) ||
    c.epoch < 0 ||
    !email(c.recipient) ||
    !Array.isArray(c.senders) ||
    !c.senders.length ||
    c.senders.length > 16 ||
    !c.senders.every(email) ||
    !text(c.searchQuery, 1000) ||
    !Number.isSafeInteger(c.after) ||
    !Number.isSafeInteger(c.before) ||
    c.after >= c.before
  )
    throw unavailable();
  if (c.accountEmail !== undefined && !email(c.accountEmail))
    throw unavailable();
  // Bills go to the configured recipient. Another connected Google account
  // cannot find them; say so instead of reporting no bill.
  if (
    c.accountEmail !== undefined &&
    !sameAccountAddress(c.accountEmail, c.recipient)
  )
    throw unavailable("account_mismatch");
  const url = new URL(c.providerOrigin);
  if (url.protocol !== "https:" || url.origin !== c.providerOrigin)
    throw unavailable();
  Object.freeze(c.senders);
  return Object.freeze(c);
}
/**
 * The connected Google account can receive mail for the configured recipient.
 * Either side may be shown masked (for example `m•••@example.org`); a mask
 * character stands for one or more hidden characters of the local part.
 */
export function sameAccountAddress(account, recipient) {
  if (typeof account !== "string" || typeof recipient !== "string")
    return false;
  const split = (value) => {
    const at = value.lastIndexOf("@");
    return at > 0
      ? [value.slice(0, at).toLowerCase(), value.slice(at + 1).toLowerCase()]
      : null;
  };
  const a = split(account),
    b = split(recipient);
  if (!a || !b || a[1] !== b[1]) return false;
  const mask = /[*\u2022\u00b7]+/u;
  const pattern = (local) =>
    new RegExp(
      `^${local
        .split(mask)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".+")}$`,
      "u",
    );
  if (mask.test(a[0]) && mask.test(b[0])) return false;
  if (mask.test(a[0])) return pattern(a[0]).test(b[0]);
  if (mask.test(b[0])) return pattern(b[0]).test(a[0]);
  return a[0] === b[0];
}
// Domains are case-insensitive; local parts retain the host's exact sender grants.
function sameAddress(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aAt = a.lastIndexOf("@"),
    bAt = b.lastIndexOf("@");
  return (
    aAt > 0 &&
    bAt > 0 &&
    a.slice(0, aAt) === b.slice(0, bAt) &&
    a.slice(aAt + 1).toLowerCase() === b.slice(bAt + 1).toLowerCase()
  );
}
function matches(m, c) {
  const time = Date.parse(m?.receivedAt);
  return (
    text(m?.externalId, 256) &&
    /^[A-Za-z0-9_-]+$/.test(m.externalId) &&
    c.senders.some((sender) => sameAddress(sender, m.fromEmail)) &&
    Array.isArray(m.to) &&
    m.to.some((to) => sameAddress(to, c.recipient)) &&
    Number.isFinite(time) &&
    time >= c.after &&
    time < c.before
  );
}
/** Identity facts a look-alike message can differ in, in report order. */
export const BILL_SOURCE_CONFLICT_FIELDS = Object.freeze([
  "company",
  "accountLabel",
  "origin",
]);
/**
 * A message for another company, account or website is a look-alike. It is
 * reported only by which identity facts differ, never selected. Its own
 * company, account and website come from an untrusted email and are never
 * shown, so a spoofed message cannot put a destination in front of the
 * person. A message whose facts are not complete or valid is unreadable and
 * is skipped.
 */
function candidate(
  parsed,
  detail,
  c,
  source = {
    kind: "gmail-message",
    messageId: detail.message.externalId,
    contentSha256: hash(detail.bodyText),
  },
) {
  if (
    !parsed ||
    ![parsed.company, parsed.accountLabel, parsed.origin].every((v) => text(v))
  )
    return { unreadable: true };
  if (
    parsed.company !== c.company ||
    parsed.accountLabel !== c.accountLabel ||
    parsed.origin !== c.providerOrigin
  )
    return {
      conflict: {
        differs: BILL_SOURCE_CONFLICT_FIELDS.filter((key) =>
          key === "origin"
            ? parsed.origin !== c.providerOrigin
            : parsed[key] !== c[key],
        ),
      },
    };
  if (
    !text(parsed.invoiceId, 128) ||
    !Number.isSafeInteger(parsed.amountMinor) ||
    parsed.amountMinor < 0 ||
    !/^[A-Z]{3}$/.test(parsed.currency) ||
    !Number.isInteger(parsed.currencyDigits) ||
    parsed.currencyDigits < 0 ||
    parsed.currencyDigits > 4 ||
    (parsed.dueDate != null && !date(parsed.dueDate)) ||
    (parsed.serviceAddress != null && !text(parsed.serviceAddress)) ||
    (parsed.servicePeriod != null &&
      (!date(parsed.servicePeriod.startsOn) ||
        !date(parsed.servicePeriod.endsOn) ||
        parsed.servicePeriod.startsOn > parsed.servicePeriod.endsOn))
  )
    return { unreadable: true };
  // Canonical invoice identity is independent of message delivery and amount.
  // Contradictory revisions of the same invoice must remain ambiguous.
  const billId = hash([
    c.accountId,
    c.billingAccountRef,
    c.providerOrigin,
    parsed.invoiceId,
  ]);
  const facts = {
    company: c.company,
    origin: c.providerOrigin,
    accountLabel: c.accountLabel,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    currencyDigits: parsed.currencyDigits,
    ...(parsed.dueDate != null ? { dueDate: parsed.dueDate } : {}),
    ...(parsed.serviceAddress != null
      ? { serviceAddress: parsed.serviceAddress }
      : {}),
    ...(parsed.servicePeriod != null
      ? {
          servicePeriod: {
            startsOn: parsed.servicePeriod.startsOn,
            endsOn: parsed.servicePeriod.endsOn,
          },
        }
      : {}),
  };
  // A link names the full mailbox address, never a masked one.
  const unmasked = [c.accountEmail, c.recipient].find(
    (value) => value !== undefined && !/[*\u2022\u00b7]/u.test(value),
  );
  const url = gmailSourceLink(
    detail.message.htmlLink,
    detail.message.threadId,
    unmasked,
  );
  return {
    billId,
    sourceRef: `bill-source:${billId}`,
    receivedAt: new Date(Date.parse(detail.message.receivedAt)).toISOString(),
    facts,
    sources: [
      {
        ...source,
        accountRef: hash(c.accountId),
        ...(url ? { threadId: detail.message.threadId, url } : {}),
      },
    ],
  };
}

/** Product bill policy over the existing Google read port. No model action or browser effect. */
export class BillSourceDiscovery {
  #generation = 0;
  constructor({
    google,
    authorize,
    authorizeReceipt = authorize,
    parse,
    attachmentPolicy,
    parseAttachment,
    maxAttachmentBytes,
  }) {
    if (
      !google ||
      !["searchGmailMessagesPage", "getGmailMessageDetail"].every(
        (key) => typeof google[key] === "function",
      ) ||
      typeof authorize !== "function" ||
      typeof parse !== "function"
    )
      throw unavailable();
    this.google = google;
    this.authorize = authorize;
    this.authorizeReceipt = authorizeReceipt;
    this.parse = parse;
    this.attachmentPolicy = attachmentPolicy;
    this.parseAttachment = parseAttachment;
    this.maxAttachmentBytes = maxAttachmentBytes;
  }
  revoke() {
    this.#generation++;
  }
  /**
   * After an outcome, look once for its receipt email: from the bill's
   * senders, to the bill's recipient, after the outcome, naming its provider
   * reference. Only one such message counts as found; none or several do not.
   * The search reads at most one page of 10 messages.
   */
  async findReceipt(input, outcome, signal) {
    try {
      if (
        typeof outcome?.reference !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(outcome.reference) ||
        !Number.isSafeInteger(outcome.observedAt)
      )
        return false;
      const after = outcome.observedAt - 10 * 60 * 1000;
      // The task's own mailbox scope is what is authorized; only the time
      // window of this search is narrowed to after the outcome.
      const authorizedScope = scope(input);
      const c = scope({ ...input, after, before: Date.now() + 60 * 1000 }),
        generation = this.#generation;
      const check = async () => {
        signal.throwIfAborted();
        if (
          generation !== this.#generation ||
          !(await this.authorizeReceipt(authorizedScope)) ||
          generation !== this.#generation
        )
          throw unavailable();
        signal.throwIfAborted();
      };
      await check();
      const result = await this.google.searchGmailMessagesPage({
        accountId: c.accountId,
        query: `{${c.senders.map((sender) => `from:${sender}`).join(" ")}} "${outcome.reference}" after:${Math.floor(after / 1000)}`,
        pageSize: 10,
      });
      await check();
      if (!Array.isArray(result?.messages) || result.messages.length > 10)
        throw unavailable();
      // More than one page is more than one possible receipt.
      if (result.nextPageToken) return false;
      const named = new RegExp(
        `(?:^|[^A-Za-z0-9])${outcome.reference.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:$|[^A-Za-z0-9])`,
      );
      let found = 0;
      for (const message of result.messages) {
        if (!matches(message, c)) continue;
        const detail = await this.google.getGmailMessageDetail({
          accountId: c.accountId,
          messageId: message.externalId,
        });
        await check();
        if (
          detail?.message?.externalId !== message.externalId ||
          !matches(detail.message, c) ||
          typeof detail.bodyText !== "string"
        )
          throw unavailable();
        if (named.test(detail.bodyText)) found++;
      }
      return found === 1;
    } catch (error) {
      throw unavailable(failureReason(error));
    }
  }
  async discover(input, signal) {
    try {
      const c = scope(input),
        generation = this.#generation;
      const check = async () => {
        signal.throwIfAborted();
        if (
          generation !== this.#generation ||
          !(await this.authorize(c)) ||
          generation !== this.#generation
        )
          throw unavailable();
        signal.throwIfAborted();
      };
      const found = new Map(),
        invoices = new Map(),
        seen = new Set(),
        tokens = new Set(),
        conflicts = new Map();
      let token,
        conflict = false,
        unreadable = 0,
        newestUnreadable = "";
      // A newer message that cannot be read may be the current bill.
      const skip = (detail) => {
        unreadable++;
        const at = new Date(
          Date.parse(detail.message.receivedAt),
        ).toISOString();
        if (at > newestUnreadable) newestUnreadable = at;
      };
      await check();
      for (;;) {
        const result = await this.google.searchGmailMessagesPage({
          accountId: c.accountId,
          query: c.searchQuery,
          pageSize: 25,
          pageToken: token,
        });
        await check();
        if (!Array.isArray(result?.messages) || result.messages.length > 25)
          throw unavailable();
        for (const message of result.messages) {
          if (!matches(message, c) || seen.has(message.externalId)) continue;
          seen.add(message.externalId);
          await check();
          const detail = await this.google.getGmailMessageDetail({
            accountId: c.accountId,
            messageId: message.externalId,
          });
          await check();
          if (
            detail?.message?.externalId !== message.externalId ||
            !matches(detail.message, c) ||
            typeof detail.bodyText !== "string"
          )
            throw unavailable();
          // One message the reviewed parser cannot read does not end the
          // search. Read-port failures below still do.
          let parsed;
          try {
            parsed = await this.parse(detail, c);
          } catch {
            parsed = undefined;
          }
          await check();
          const documents = await readBillAttachments({
            google: this.google,
            detail,
            context: c,
            check,
            signal,
            policy: this.attachmentPolicy,
            parse: this.parseAttachment,
            maxBytes: this.maxAttachmentBytes,
          });
          if (documents.incomplete)
            return { status: "incomplete", candidates: [] };
          if (parsed === undefined && !documents.found.length) skip(detail);
          const extracted = [
            ...(parsed == null ? [] : [{ parsed }]),
            ...documents.found,
          ];
          for (const document of extracted) {
            const value = candidate(
              document.parsed,
              detail,
              c,
              document.source,
            );
            if (value.unreadable) {
              skip(detail);
              continue;
            }
            if (value.conflict) {
              const key = hash(value.conflict);
              if (!conflicts.has(key)) conflicts.set(key, value.conflict);
              continue;
            }
            const version = hash(value.facts),
              key = `${value.billId}:${version}`,
              previous = found.get(key);
            if (
              invoices.has(value.billId) &&
              invoices.get(value.billId) !== version
            )
              conflict = true;
            invoices.set(value.billId, version);
            if (previous) {
              previous.sources.push(...value.sources);
              if (value.receivedAt > previous.receivedAt)
                previous.receivedAt = value.receivedAt;
            } else found.set(key, { ...value, candidateId: hash(key) });
          }
        }
        token = result.nextPageToken;
        if (token == null || token === "") break;
        if (!text(token, 4096)) throw unavailable();
        // Partial search must never be presented as a unique selected bill.
        if (tokens.has(token)) return { status: "incomplete", candidates: [] };
        tokens.add(token);
      }
      await check();
      // Newest first. The person sees which bill arrived most recently.
      const candidates = [...found.values()].sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      );
      const notes = {
        ...(unreadable ? { unreadable } : {}),
        ...(conflicts.size ? { conflicts: [...conflicts.values()] } : {}),
      };
      // An older readable bill is never offered as current while a newer
      // message from the biller could not be read.
      if (candidates.length && newestUnreadable > candidates[0].receivedAt)
        return {
          status: "incomplete",
          reason: "newer-unreadable",
          candidates: [],
          ...notes,
        };
      if (candidates.length) candidates[0].mostRecent = true;
      if (conflict)
        return {
          status: "ambiguous",
          reason: "conflicting-invoice",
          candidates,
          ...notes,
        };
      return {
        status:
          candidates.length === 1
            ? "candidate"
            : candidates.length > 1
              ? "ambiguous"
              : conflicts.size
                ? "conflicting-source"
                : unreadable
                  ? "incomplete"
                  : "missing",
        candidates,
        ...notes,
      };
    } catch (error) {
      throw unavailable(failureReason(error));
    } // Provider/parser errors may contain private message bodies.
  }
}
