import { createHash } from "node:crypto";
import { readBillAttachments } from "./bill-attachment-reader.mjs";
import { gmailSourceLink } from "./bill-source-link.mjs";
import { BillHostError } from "./errors.mjs";

const unavailable = () =>
  Object.assign(
    new BillHostError(
      "Bill sources are unavailable. Recheck the connected account and task.",
    ),
    { code: "BILL_SOURCES_UNAVAILABLE" },
  );
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
  const url = new URL(c.providerOrigin);
  if (url.protocol !== "https:" || url.origin !== c.providerOrigin)
    throw unavailable();
  Object.freeze(c.senders);
  return Object.freeze(c);
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
    !text(parsed.invoiceId, 128) ||
    parsed.company !== c.company ||
    parsed.accountLabel !== c.accountLabel ||
    parsed.origin !== c.providerOrigin ||
    !Number.isSafeInteger(parsed.amountMinor) ||
    parsed.amountMinor < 0 ||
    !/^[A-Z]{3}$/.test(parsed.currency) ||
    !Number.isInteger(parsed.currencyDigits) ||
    parsed.currencyDigits < 0 ||
    parsed.currencyDigits > 4 ||
    !date(parsed.dueDate) ||
    (parsed.serviceAddress != null && !text(parsed.serviceAddress))
  )
    throw unavailable();
  if (
    parsed.servicePeriod != null &&
    (!date(parsed.servicePeriod.startsOn) ||
      !date(parsed.servicePeriod.endsOn) ||
      parsed.servicePeriod.startsOn > parsed.servicePeriod.endsOn)
  )
    throw unavailable();
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
    dueDate: parsed.dueDate,
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
  const url = gmailSourceLink(
    detail.message.htmlLink,
    detail.message.threadId,
    c.accountEmail ?? c.recipient,
  );
  return {
    billId,
    sourceRef: `bill-source:${billId}`,
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
    this.parse = parse;
    this.attachmentPolicy = attachmentPolicy;
    this.parseAttachment = parseAttachment;
    this.maxAttachmentBytes = maxAttachmentBytes;
  }
  revoke() {
    this.#generation++;
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
        tokens = new Set();
      let token,
        conflict = false;
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
          const parsed = await this.parse(detail, c);
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
          const extracted = [
            ...(parsed === null ? [] : [{ parsed }]),
            ...documents.found,
          ];
          for (const document of extracted) {
            const value = candidate(
                document.parsed,
                detail,
                c,
                document.source,
              ),
              version = hash(value.facts),
              key = `${value.billId}:${version}`,
              previous = found.get(key);
            if (
              invoices.has(value.billId) &&
              invoices.get(value.billId) !== version
            )
              conflict = true;
            invoices.set(value.billId, version);
            if (previous) previous.sources.push(...value.sources);
            else found.set(key, { ...value, candidateId: hash(key) });
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
      if (conflict)
        return {
          status: "ambiguous",
          reason: "conflicting-invoice",
          candidates: [...found.values()],
        };
      const candidates = [...found.values()];
      return {
        status:
          candidates.length === 0
            ? "missing"
            : candidates.length === 1
              ? "candidate"
              : "ambiguous",
        candidates,
      };
    } catch {
      throw unavailable();
    } // Provider/parser errors may contain private message bodies.
  }
}
