import crypto from "node:crypto";
import { logger } from "@elizaos/core";
import { BLOOIO_CONSTANTS } from "./constants";

const E164_REGEX = /^\+\d{1,15}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GROUP_REGEX = /^grp_[A-Za-z0-9]+$/;

export function isE164(value: string): boolean {
  return E164_REGEX.test(value);
}

export function isEmail(value: string): boolean {
  return EMAIL_REGEX.test(value);
}

export function isGroupId(value: string): boolean {
  return GROUP_REGEX.test(value);
}

export function validateChatId(chatId: string): boolean {
  const parts = chatId
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return false;
  }

  return parts.every((part) => isE164(part) || isEmail(part) || isGroupId(part));
}

export function normalizeChatIdList(recipients: string[]): string {
  return recipients
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
}

export function extractChatIdCandidates(text: string): string[] {
  const matches: Array<{ value: string; index: number }> = [];

  const capture = (regex: RegExp) => {
    let match: RegExpExecArray | null = regex.exec(text);
    while (match) {
      matches.push({ value: match[0], index: match.index });
      match = regex.exec(text);
    }
  };

  capture(/\+\d{1,15}/g);
  capture(/\bgrp_[A-Za-z0-9]+\b/g);
  capture(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g);

  matches.sort((a, b) => a.index - b.index);
  const unique: string[] = [];
  for (const match of matches) {
    if (!unique.includes(match.value)) {
      unique.push(match.value);
    }
  }
  return unique;
}

export function extractAttachmentUrls(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  return Array.from(new Set(urls));
}

export function stripChatIdsFromText(text: string, chatIds: string[]): string {
  let cleaned = text;
  for (const chatId of chatIds) {
    const escaped = escapeRegExp(chatId);
    cleaned = cleaned.replace(new RegExp(escaped, "g"), "");
  }
  return cleaned.trim();
}

export function getWebhookPath(webhookUrl: string): string {
  try {
    const parsed = new URL(webhookUrl);
    return parsed.pathname || BLOOIO_CONSTANTS.WEBHOOK_PATHS.EVENTS;
  } catch (error) {
    logger.warn({ error: String(error) }, "Invalid webhook URL, using default path");
    return BLOOIO_CONSTANTS.WEBHOOK_PATHS.EVENTS;
  }
}

export function verifyWebhookSignature(
  secret: string,
  signatureHeader: string,
  rawBody: string,
  toleranceSeconds: number = BLOOIO_CONSTANTS.SIGNATURE_TOLERANCE_SECONDS
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    logger.warn(
      { signatureHeader: signatureHeader.substring(0, 50) },
      "Failed to parse signature header"
    );
    return false;
  }

  const { timestamp, signature } = parsed;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) {
    logger.warn({ timestamp }, "Invalid timestamp in signature");
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const timeDiff = Math.abs(nowSeconds - timestampNumber);
  if (timeDiff > toleranceSeconds) {
    logger.warn(
      { timestampNumber, nowSeconds, timeDiff, toleranceSeconds },
      "Webhook signature timestamp out of tolerance"
    );
    return false;
  }

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const isValid = timingSafeEqual(expected, signature);

  if (!isValid) {
    logger.warn(
      {
        expectedFirst8: expected.substring(0, 8),
        actualFirst8: signature.substring(0, 8),
        bodyLength: rawBody.length,
      },
      "Webhook signature mismatch"
    );
  }

  return isValid;
}

function parseSignatureHeader(header: string): { timestamp: string; signature: string } | null {
  const parts = header.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signaturePart = parts.find((part) => part.startsWith("v1="));
  if (!timestampPart || !signaturePart) {
    return null;
  }
  const timestamp = timestampPart.split("=")[1];
  const signature = signaturePart.split("=")[1];
  if (!timestamp || !signature) {
    return null;
  }
  return { timestamp, signature };
}

function timingSafeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
