import type { InboxReviewedEffect } from "./inbox-operation-routes";
import { DefiniteProviderRejection, InboxContractError, type InboxOwner } from "./inbox-receipts";

export interface InboxGoogleGrant {
  token: string;
  email: string;
  scopes: string[];
}
export interface InboxGoogleDependencies {
  grant(owner: InboxOwner): Promise<InboxGoogleGrant>;
  /** Production uses global fetch and the fixed Google origin below. Tests supply a closed transport. */
  fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  normalizeMessage?(
    message: Record<string, unknown>,
    selfEmail: string,
  ): { message: Record<string, unknown>; bodyText: string } | null;
}
const endpoint = "https://gmail.googleapis.com/gmail/v1/users/me";
const fullScope = "https://mail.google.com/",
  scopePrefix = "https://www.googleapis.com/auth/gmail.";
const encoder = new TextEncoder();
export async function inboxDigest(text: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(text))).toString("hex");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InboxContractError(400, "Object required");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, headers = false): string {
  if (typeof value !== "string" || value.length > max || (headers && /[\r\n\0]/.test(value)))
    throw new InboxContractError(400, "Invalid mail text");
  return value;
}
function providerId(value: unknown): string {
  const id = text(value, 256, true);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new InboxContractError(400, "Invalid provider identity");
  return id;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new InboxContractError(400, "Unexpected mail field");
}
function mailbox(value: unknown): string {
  const address = text(value, 254, true);
  if (
    !/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      address,
    ) ||
    address.includes("..")
  )
    throw new InboxContractError(400, "Use an unambiguous email address without a display name");
  return address;
}
function addresses(value: unknown, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 50 || (required && !value.length))
    throw new InboxContractError(400, "Invalid recipient list");
  return value.map(mailbox);
}
function requireScope(grant: InboxGoogleGrant, kind: "read" | "send" | "draft" | "modify") {
  const allowed =
    kind === "read"
      ? ["readonly", "modify"]
      : kind === "send"
        ? ["send", "compose", "modify"]
        : kind === "draft"
          ? ["compose", "modify"]
          : ["modify"];
  if (
    !grant.scopes.includes(fullScope) &&
    !allowed.some((scope) => grant.scopes.includes(scopePrefix + scope))
  )
    throw new InboxContractError(403, "The selected Google grant lacks this capability");
}
function encodedSubject(subject: string): string {
  const chunks: string[] = [];
  let current = "";
  for (const point of subject) {
    if (encoder.encode(current + point).length > 42) {
      chunks.push(current);
      current = "";
    }
    current += point;
  }
  chunks.push(current);
  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`)
    .join("\r\n ");
}
function recipientHeader(name: string, values: string[]): string {
  return `${name}: ${values.join(",\r\n ")}`;
}
function referenceHeader(value: string): string {
  const identities = value.trim().split(/\s+/);
  if (identities.some((identity) => identity.length > 254))
    throw new InboxContractError(409, "Selected message has oversized reply identities");
  return `References: ${identities.join("\r\n ")}`;
}
function payloadHeader(payload: Record<string, unknown>, name: string): string | null {
  const headers = payload.headers;
  if (!Array.isArray(headers)) return null;
  const matching = headers.filter((value) => {
    const row = object(value);
    return typeof row.name === "string" && row.name.toLowerCase() === name.toLowerCase();
  });
  if (matching.length !== 1) return null;
  return text(object(matching[0]).value, 4096, true);
}
const attachmentLimit = 5 * 1024 * 1024;
const attachmentTypes: Record<string, RegExp> = {
  "text/plain": /\.txt$/i,
  "application/pdf": /\.pdf$/i,
  "image/png": /\.png$/i,
  "image/jpeg": /\.jpe?g$/i,
  "image/webp": /\.webp$/i,
};
function supportedAttachment(name: string, mime: unknown) {
  return (
    name.length > 0 &&
    name.length <= 120 &&
    !/[\\/\x00-\x1f\x7f]/.test(name) &&
    typeof mime === "string" &&
    !!attachmentTypes[mime]?.test(name)
  );
}
function attachmentParts(payload: Record<string, unknown>) {
  const result: Record<string, unknown>[] = [];
  let visited = 0;
  const visit = (part: Record<string, unknown>) => {
    if (++visited > 200) throw new InboxContractError(413, "Too many MIME parts");
    if (typeof part.filename === "string" && part.filename) result.push(part);
    if (Array.isArray(part.parts)) for (const child of part.parts) visit(object(child));
  };
  visit(payload);
  return result;
}
function checkedAttachment(value: unknown) {
  const item = object(value);
  fields(item, ["name", "mimeType", "dataBase64"]);
  const name = text(item.name, 120, true),
    mimeType = text(item.mimeType, 100, true);
  if (!supportedAttachment(name, mimeType))
    throw new InboxContractError(400, "Supported attachments: PDF, PNG, JPEG, WebP and UTF-8 TXT");
  const data = text(item.dataBase64, 7 * 1024 * 1024);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > attachmentLimit) throw new InboxContractError(413, "Attachment exceeds 5 MiB");
  if (bytes.toString("base64") !== data)
    throw new InboxContractError(400, "Invalid attachment encoding");
  let valid = false;
  if (mimeType === "text/plain") {
    try {
      valid = !new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0");
    } catch {
      throw new InboxContractError(400, "Attachment must be UTF-8");
    }
  }
  if (mimeType === "application/pdf") valid = bytes.subarray(0, 5).toString() === "%PDF-";
  if (mimeType === "image/png")
    valid = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") valid = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (mimeType === "image/webp")
    valid =
      bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new InboxContractError(400, "Attachment content does not match its type");
  return { name, mimeType, dataBase64: data, size: bytes.length };
}
/** Fixed-path, single-attempt Google transport. Timeout covers headers and bounded body consumption. */
export class InboxGoogleProvider {
  constructor(private readonly dependencies: InboxGoogleDependencies) {}
  private async request(
    grant: InboxGoogleGrant,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await (this.dependencies.fetch ?? fetch)(endpoint + path, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${grant.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([400, 401, 403, 404, 409, 412, 422].includes(response.status))
          throw new DefiniteProviderRejection(String(response.status));
        throw new Error("Ambiguous Google response");
      }
      if (response.status === 204) return {};
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing Google response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 12 * 1024 * 1024) {
            await reader.cancel();
            throw new InboxContractError(413, "Provider result exceeds the explicit size limit");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } finally {
      clearTimeout(timer);
    }
  }
  async capabilities(owner: InboxOwner) {
    const grant = await this.dependencies.grant(owner);
    const supported = (kind: "read" | "send" | "draft" | "modify") => {
      try {
        requireScope(grant, kind);
        return true;
      } catch {
        return false;
      }
    };
    return {
      version: 1,
      from: grant.email,
      threads: supported("read") && Boolean(this.dependencies.normalizeMessage),
      send: supported("send"),
      providerDrafts: supported("draft"),
      mailboxMutations: supported("modify"),
      attachments: true,
      attachmentPolicy: {
        mimeTypes: Object.keys(attachmentTypes),
        maximumBytes: attachmentLimit,
        maximumOutgoing: 1,
      },
      providerExactlyOnce: false,
      atomicDraftReplacement: false,
    };
  }
  async thread(owner: InboxOwner, threadId: string, offset = 0, expectedHistoryId?: string) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 2000 ||
      (offset > 0 && !expectedHistoryId)
    )
      throw new InboxContractError(
        400,
        "A continuation offset requires the reviewed thread history identity",
      );
    const normalizeMessage = this.dependencies.normalizeMessage;
    if (!normalizeMessage) throw new InboxContractError(409, "Thread decoding is unavailable");
    const grant = await this.dependencies.grant(owner);
    requireScope(grant, "read");
    const id = providerId(threadId),
      result = await this.request(grant, `/threads/${id}?format=full`);
    if (result.id !== id || typeof result.historyId !== "string" || !Array.isArray(result.messages))
      throw new InboxContractError(502, "Incomplete Google thread response");
    if (expectedHistoryId && result.historyId !== expectedHistoryId)
      throw new InboxContractError(409, "Thread changed during paging; reopen it");
    if (result.messages.length > 2000)
      throw new InboxContractError(413, "Thread exceeds the explicit 2000-message support limit");
    const all = result.messages
      .map(object)
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    if (offset > all.length)
      throw new InboxContractError(400, "Thread offset is outside the current snapshot");
    if (
      all.some(
        (message) => message.threadId !== id || !Number.isFinite(Number(message.internalDate)),
      )
    )
      throw new InboxContractError(502, "Inconsistent Google thread messages");
    const messages = all.slice(offset, offset + 25).map((raw) => {
      const normalized = normalizeMessage(raw, grant.email);
      if (!normalized) throw new InboxContractError(502, "Incomplete thread message");
      if (encoder.encode(normalized.bodyText).length > 256 * 1024)
        throw new InboxContractError(413, "Message body exceeds the explicit display limit");
      return {
        ...normalized,
        historyId: typeof raw.historyId === "string" ? raw.historyId : null,
        attachments: attachmentParts(object(raw.payload)).map((part) => {
          const body = object(part.body),
            name = typeof part.filename === "string" ? part.filename : "attachment";
          return {
            partId: typeof part.partId === "string" ? part.partId : "",
            name,
            mimeType: part.mimeType,
            size: body.size,
            supported:
              supportedAttachment(name, part.mimeType) &&
              typeof body.size === "number" &&
              body.size >= 0 &&
              body.size <= attachmentLimit,
          };
        }),
      };
    });
    let pageBytes = 0,
      pageCount = 0;
    for (const message of messages) {
      const size = encoder.encode(JSON.stringify(message)).length;
      if (size > 1536 * 1024)
        throw new InboxContractError(413, "Message metadata exceeds the display limit");
      if (pageBytes + size > 1536 * 1024) break;
      pageBytes += size;
      pageCount++;
    }
    messages.splice(pageCount);
    return {
      version: 1,
      threadId: id,
      historyId: result.historyId,
      total: all.length,
      offset,
      nextOffset: offset + messages.length < all.length ? offset + messages.length : null,
      messages,
    };
  }
  async attachment(owner: InboxOwner, messageId: string, partId: string, historyId: string) {
    const grant = await this.dependencies.grant(owner);
    requireScope(grant, "read");
    const id = providerId(messageId),
      message = await this.request(grant, `/messages/${id}?format=full`);
    if (message.id !== id || message.historyId !== historyId)
      throw new InboxContractError(409, "Message changed; reopen its attachments");
    const matching = attachmentParts(object(message.payload)).filter(
      (part) => part.partId === partId,
    );
    if (matching.length !== 1) throw new InboxContractError(404, "Attachment not found");
    const part = matching[0],
      body = object(part.body);
    if (
      !supportedAttachment(String(part.filename || ""), part.mimeType) ||
      typeof body.size !== "number" ||
      body.size < 0 ||
      body.size > attachmentLimit
    )
      throw new InboxContractError(
        413,
        "Supported PDF, image or TXT attachments must be at most 5 MiB",
      );
    const raw = body.attachmentId
      ? await this.request(grant, `/messages/${id}/attachments/${providerId(body.attachmentId)}`)
      : body;
    const encoded = text(raw.data, 7 * 1024 * 1024);
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded))
      throw new InboxContractError(502, "Invalid provider attachment");
    const file = checkedAttachment({
      name: part.filename,
      mimeType: part.mimeType,
      dataBase64: Buffer.from(encoded, "base64url").toString("base64"),
    });
    if (file.size !== body.size || raw.size !== body.size)
      throw new InboxContractError(502, "Attachment byte count changed");
    return {
      version: 1,
      messageId: id,
      partId,
      historyId,
      ...file,
      sha256: Buffer.from(
        await crypto.subtle.digest("SHA-256", Buffer.from(file.dataBase64, "base64")),
      ).toString("hex"),
    };
  }
  async draft(owner: InboxOwner, draftId: string) {
    const grant = await this.dependencies.grant(owner);
    requireScope(grant, "draft");
    const selectedId = providerId(draftId);
    const result = await this.request(grant, `/drafts/${selectedId}?format=raw`),
      message = object(result.message),
      raw = text(message.raw, 12 * 1024 * 1024);
    if (result.id !== selectedId)
      throw new InboxContractError(502, "Provider returned a different draft");
    return {
      id: providerId(result.id),
      messageId: providerId(message.id),
      raw,
      providerDigest: await inboxDigest(raw),
    };
  }
  async review(
    owner: InboxOwner,
    proposal: unknown,
    requestId: string,
  ): Promise<InboxReviewedEffect> {
    const value = object(proposal),
      kind = value.kind,
      grant = await this.dependencies.grant(owner);
    if (kind === "archive" || kind === "unarchive" || kind === "trash" || kind === "untrash") {
      fields(value, ["kind", "messageId", "expectedHistoryId"]);
      requireScope(grant, "modify");
      const messageId = providerId(value.messageId),
        expectedHistoryId = text(value.expectedHistoryId, 100, true),
        current = await this.request(grant, `/messages/${messageId}?format=minimal`);
      if (current.id !== messageId || current.historyId !== expectedHistoryId)
        throw new InboxContractError(409, "Selected message changed; review its current labels");
      const review = { kind, messageId, expectedHistoryId, from: grant.email },
        digest = await inboxDigest(JSON.stringify(review));
      return {
        kind,
        digest,
        review,
        perform: async () => {
          const result =
            kind === "archive" || kind === "unarchive"
              ? await this.request(
                  grant,
                  `/messages/${messageId}/modify`,
                  "POST",
                  kind === "archive" ? { removeLabelIds: ["INBOX"] } : { addLabelIds: ["INBOX"] },
                )
              : await this.request(grant, `/messages/${messageId}/${kind}`, "POST");
          if (
            result.id !== messageId ||
            !Array.isArray(result.labelIds) ||
            !result.labelIds.every((label) => typeof label === "string")
          )
            throw Error("Provider mutation readback is incomplete");
          const labels = result.labelIds as string[];
          if (
            (kind === "archive" && labels.includes("INBOX")) ||
            (kind === "unarchive" && !labels.includes("INBOX")) ||
            (kind === "trash" && !labels.includes("TRASH")) ||
            (kind === "untrash" && labels.includes("TRASH"))
          )
            throw Error("Provider labels did not verify the requested state");
          return {
            messageId,
            labelIds: labels,
            historyId: result.historyId ?? null,
          };
        },
      };
    }
    if (kind === "draft-delete") {
      fields(value, ["kind", "draftId", "expectedDigest", "confirmPermanentDelete"]);
      requireScope(grant, "draft");
      if (value.confirmPermanentDelete !== true)
        throw new InboxContractError(
          400,
          "Permanent provider draft deletion requires confirmation",
        );
      const draftId = providerId(value.draftId),
        current = await this.draft(owner, draftId);
      if (current.providerDigest !== value.expectedDigest)
        throw new InboxContractError(409, "Provider draft changed");
      const review = {
          kind,
          draftId,
          expectedDigest: current.providerDigest,
          from: grant.email,
          permanent: true,
        },
        digest = await inboxDigest(JSON.stringify(review));
      return {
        kind,
        digest,
        review,
        perform: async () => {
          await this.request(grant, `/drafts/${draftId}`, "DELETE");
          return { draftId, deleted: true };
        },
      };
    }
    if (kind !== "send" && kind !== "draft-create" && kind !== "draft-replace")
      throw new InboxContractError(400, "Unsupported mail operation");
    fields(value, [
      "kind",
      "mode",
      "to",
      "cc",
      "bcc",
      "subject",
      "bodyText",
      "replyMessageId",
      "draftId",
      "expectedDigest",
      "acceptNonAtomicReplacement",
      "attachments",
    ]);
    requireScope(grant, kind === "send" ? "send" : "draft");
    const mode = value.mode;
    if (!["compose", "reply", "reply-all", "forward"].includes(String(mode)))
      throw new InboxContractError(400, "Explicit compose mode required");
    const from = mailbox(grant.email),
      to = addresses(value.to),
      cc = addresses(value.cc),
      bcc = addresses(value.bcc),
      subject = text(value.subject, 500, true),
      bodyText = text(value.bodyText, 64000);
    if (kind === "send" && to.length + cc.length + bcc.length === 0)
      throw new InboxContractError(400, "At least one recipient is required to send");
    if (to.length + cc.length + bcc.length > 50)
      throw new InboxContractError(400, "At most 50 recipients are supported");
    let threadId: string | undefined, inReplyTo: string | undefined, references: string | undefined;
    if (mode === "reply" || mode === "reply-all") {
      requireScope(grant, "read");
      const replyMessageId = providerId(value.replyMessageId);
      const selected = await this.request(grant, `/messages/${replyMessageId}?format=metadata`),
        payload = object(selected.payload),
        parentId = payloadHeader(payload, "Message-ID"),
        parentSubject = payloadHeader(payload, "Subject");
      if (
        selected.id !== replyMessageId ||
        !parentId ||
        parentId.length > 254 ||
        !/^<[^<>\s]+@[^<>\s]+>$/.test(parentId) ||
        parentSubject === null
      )
        throw new InboxContractError(409, "Selected message lacks safe reply headers");
      const expected = /^re:/i.test(parentSubject) ? parentSubject : `Re: ${parentSubject}`;
      if (subject !== expected)
        throw new InboxContractError(409, "Reply subject must match the selected message");
      threadId = providerId(selected.threadId);
      inReplyTo = parentId;
      const chain = payloadHeader(payload, "References");
      if (chain && !/^(?:<[^<>\s]+@[^<>\s]+>\s*)+$/.test(chain))
        throw new InboxContractError(409, "Selected message has unsupported References");
      references = chain ? `${chain} ${parentId}` : parentId;
    } else if (value.replyMessageId !== undefined)
      throw new InboxContractError(400, "Reply identity is not valid for this compose mode");
    const attachments = value.attachments === undefined ? [] : value.attachments;
    if (!Array.isArray(attachments) || attachments.length > 1)
      throw new InboxContractError(400, "At most one attachment is supported");
    const files = attachments.map(checkedAttachment);
    const attachmentReview = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        sha256: Buffer.from(
          await crypto.subtle.digest("SHA-256", Buffer.from(file.dataBase64, "base64")),
        ).toString("hex"),
      })),
    );
    const boundary = `eliza-${requestId}`;
    const lines = [
      `From: ${from}`,
      recipientHeader("To", to),
      ...(cc.length ? [recipientHeader("Cc", cc)] : []),
      ...(bcc.length ? [recipientHeader("Bcc", bcc)] : []),
      `Subject: ${encodedSubject(subject)}`,
      `Message-ID: <eliza-${requestId}@message.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, referenceHeader(references ?? inReplyTo)] : []),
      "",
      Buffer.from(bodyText.replace(/\r?\n/g, "\r\n"))
        .toString("base64")
        .match(/.{1,76}/g)
        ?.join("\r\n") ?? "",
    ];
    if (files.length) {
      const content = lines.findIndex((line) => line.startsWith("Content-Type:"));
      const metadata = lines.filter(
        (_, index) => index < content || (index > content + 1 && index < lines.indexOf("")),
      );
      const body = lines.slice(lines.indexOf("") + 1).join("\r\n");
      lines.splice(
        0,
        lines.length,
        ...metadata,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        body,
        ...files.flatMap((file) => [
          `--${boundary}`,
          `Content-Type: ${file.mimeType}`,
          `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
          "Content-Transfer-Encoding: base64",
          "",
          file.dataBase64.match(/.{1,76}/g)?.join("\r\n") || "",
        ]),
        `--${boundary}--`,
      );
    }
    const raw = Buffer.from(lines.join("\r\n")).toString("base64url"),
      mimeDigest = await inboxDigest(raw);
    let draftId: string | undefined, expectedDigest: string | undefined;
    if (kind === "draft-replace") {
      if (value.acceptNonAtomicReplacement !== true)
        throw new InboxContractError(
          400,
          "Gmail has no atomic draft compare-and-swap; explicit replacement acknowledgement required",
        );
      draftId = providerId(value.draftId);
      expectedDigest = text(value.expectedDigest, 64, true);
      const current = await this.draft(owner, draftId);
      if (current.providerDigest !== expectedDigest)
        throw new InboxContractError(409, "Provider draft changed; read it before replacement");
    } else if (
      value.draftId !== undefined ||
      value.expectedDigest !== undefined ||
      value.acceptNonAtomicReplacement !== undefined
    )
      throw new InboxContractError(
        400,
        "Draft replacement fields are not valid for this operation",
      );
    const review = {
        kind,
        mode,
        from,
        to,
        cc,
        bcc,
        subject,
        bodyText,
        threadId: threadId ?? null,
        replyMessageId: value.replyMessageId ?? null,
        draftId: draftId ?? null,
        expectedDigest: expectedDigest ?? null,
        mimeDigest,
        attachments: attachmentReview,
        atomicDraftReplacement: false,
      },
      digest = await inboxDigest(JSON.stringify(review));
    return {
      kind,
      digest,
      review,
      perform: async () => {
        const message = { raw, ...(threadId ? { threadId } : {}) },
          result =
            kind === "send"
              ? await this.request(grant, "/messages/send", "POST", message)
              : kind === "draft-create"
                ? await this.request(grant, "/drafts", "POST", { message })
                : await this.request(grant, `/drafts/${draftId}`, "PUT", {
                    id: draftId,
                    message,
                  });
        if (kind === "send")
          return {
            messageId: providerId(result.id),
            threadId: providerId(result.threadId),
            mimeDigest,
          };
        const id = providerId(result.id),
          returned = object(result.message);
        if (draftId && id !== draftId) throw Error("Provider draft identity changed");
        const readback = await this.request(grant, `/drafts/${id}?format=raw`),
          storedRaw = text(object(readback.message).raw, 12 * 1024 * 1024);
        if (
          readback.id !== id ||
          !Buffer.from(storedRaw, "base64url").equals(Buffer.from(raw, "base64url"))
        )
          throw Error(
            "Provider draft readback differs from reviewed MIME; inspect it before another save",
          );
        return {
          draftId: id,
          messageId: providerId(returned.id),
          providerDigest: await inboxDigest(storedRaw),
          mimeDigest,
          atomicReplacement: false,
        };
      },
    };
  }
}
