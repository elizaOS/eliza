import { createHash } from "node:crypto";
import { BillHostError } from "./errors.mjs";

const failure = () => new BillHostError("Bill attachment unavailable");
/** Host-only document extraction. Parser and attachment policy are reviewed product code. */
export async function readBillAttachments({
  google,
  detail,
  context,
  check,
  signal,
  policy,
  parse,
  maxBytes = 5 * 1024 * 1024,
}) {
  const attachments = detail.attachments ?? [];
  if (
    !Array.isArray(attachments) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 25 * 1024 * 1024
  )
    throw failure();
  const found = [];
  const seen = new Set();
  for (const attachment of attachments) {
    await check();
    if (
      !attachment ||
      typeof attachment.partId !== "string" ||
      !/^[0-9.]{0,128}$/.test(attachment.partId) ||
      seen.has(attachment.partId)
    )
      throw failure();
    seen.add(attachment.partId);
    const disposition = policy
      ? await policy(structuredClone(attachment), context)
      : "unsupported";
    await check();
    if (disposition === "ignore") continue;
    if (disposition === "unsupported") return { incomplete: true, found: [] };
    if (
      disposition !== "read" ||
      typeof parse !== "function" ||
      typeof google.getGmailAttachment !== "function" ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0 ||
      attachment.size > maxBytes
    )
      throw failure();
    const value = await google.getGmailAttachment({
      accountId: context.accountId,
      messageId: detail.message.externalId,
      partId: attachment.partId,
      maxBytes,
    });
    await check();
    if (
      !value ||
      value.messageId !== detail.message.externalId ||
      ["partId", "attachmentId", "filename", "mimeType", "size"].some(
        (key) => value[key] !== attachment[key],
      ) ||
      !(value.data instanceof Uint8Array) ||
      value.data.byteLength !== attachment.size ||
      value.data.byteLength > maxBytes
    )
      throw failure();
    const sha256 = createHash("sha256").update(value.data).digest("hex");
    if (value.sha256 !== sha256) throw failure();
    const parsed = await parse(
      value,
      context,
      Object.freeze({ assertActive: check, signal }),
    );
    await check();
    if (parsed !== null)
      found.push({
        parsed,
        source: {
          kind: "gmail-attachment",
          messageId: value.messageId,
          partId: value.partId,
          filename: value.filename,
          mimeType: value.mimeType,
          contentSha256: sha256,
        },
      });
  }
  return { incomplete: false, found };
}
