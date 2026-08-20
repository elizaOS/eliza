/**
 * Turns explicit call-continuation SMS requests into bounded Twilio sends to
 * the Twilio-signed call's From number. Recipient and sender authority come
 * only from authenticated, signed call claims.
 */

import { logger } from "@/lib/utils/logger";
import {
  isE164PhoneNumber,
  type TwilioSendMessageResponse,
  twilioApiRequest,
} from "@/lib/utils/twilio-api";

const DEFAULT_HANDOFF_BODY =
  "Eliza here — reply to this text to keep going after the call.";
const HANDOFF_LEDGER_TTL_SECONDS = 7 * 24 * 60 * 60;
const HANDOFF_HISTORY_CONTENT =
  "Voice action completed: sent the standard continuation SMS to the Twilio-attested call number.";

export type CallerSmsHandoffResult =
  | { handled: false }
  | { handled: true; response: string };

export interface CallerSmsHandoffConfig {
  accountSid: string;
  authToken: string;
  callSid: string;
  fromNumber: string;
  callerNumber: string;
  store?: CallerSmsHandoffStore;
  recordSuccess: (event: {
    id: string;
    content: string;
    createdAt: number;
  }) => Promise<void>;
  now?: () => number;
  send?: (
    accountSid: string,
    authToken: string,
    body: URLSearchParams,
    idempotencyToken: string,
  ) => Promise<void>;
}

export interface CallerSmsHandoffStore {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { nx?: boolean; ex?: number },
  ): Promise<unknown>;
}

type HandoffLedgerEntry =
  | { status: "pending" }
  | { status: "sent" | "completed"; createdAt: number };

function parseLedgerEntry(value: unknown): HandoffLedgerEntry | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.status === "pending") return { status: "pending" };
    if (
      (record.status === "sent" || record.status === "completed") &&
      typeof record.createdAt === "number" &&
      Number.isFinite(record.createdAt) &&
      record.createdAt > 0
    ) {
      return { status: record.status, createdAt: record.createdAt };
    }
  } catch {
    // error-policy:J3 malformed durable state fails closed below.
  }
  return null;
}

async function handoffIdentity(
  accountSid: string,
  callSid: string,
): Promise<{ key: string; providerToken: string }> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${accountSid}\0${callSid}`),
    ),
  );
  const encoded = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    key: `twilio:caller-sms-handoff:${encoded}`,
    providerToken: encoded,
  };
}

function requestedSmsBody(
  transcript: string,
): "continuation" | "unsupported_dictation" | null {
  const normalized = transcript.trim();
  if (/\b(?:a\s+|the\s+)?link\b/i.test(normalized)) {
    return /\b(?:text|sms|send)\b/i.test(normalized)
      ? "unsupported_dictation"
      : null;
  }
  if (
    /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:(?:text|sms)\s+(?:me|(?:this|that)\s+to\s+me)(?:\s+(?:a\s+|the\s+)?(?:text|message|link))?|send\s+me\s+(?:a\s+|the\s+)?(?:text|message|link))[.!?]*$/i.test(
      normalized,
    )
  ) {
    return "continuation";
  }
  const dictated = normalized.match(
    /^(?:please\s+)?(?:(?:text|sms)\s+me|send\s+me\s+(?:a\s+)?text)\s+(?:saying|with|this:)\s+(.+)$/i,
  )?.[1];
  return dictated?.trim() ? "unsupported_dictation" : null;
}

async function sendTwilioSms(
  accountSid: string,
  authToken: string,
  body: URLSearchParams,
  idempotencyToken: string,
): Promise<void> {
  const response = await twilioApiRequest<TwilioSendMessageResponse>(
    accountSid,
    authToken,
    "POST",
    "/Messages.json",
    body,
    { "I-Twilio-Idempotency-Token": idempotencyToken },
  );
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.sid !== "string" ||
    response.sid.trim().length === 0 ||
    typeof response.status !== "string" ||
    !new Set([
      "accepted",
      "queued",
      "sending",
      "sent",
      "delivered",
      "scheduled",
    ]).has(response.status.trim().toLowerCase())
  ) {
    throw new Error("Twilio did not return a valid message receipt");
  }
}

/** Build one call-scoped handler; successful duplicate requests send once. */
export function createCallerSmsHandoff(
  config: CallerSmsHandoffConfig,
): (transcript: string) => Promise<CallerSmsHandoffResult> {
  const send = config.send ?? sendTwilioSms;
  const now = config.now ?? Date.now;
  const numbersAreValidE164 =
    isE164PhoneNumber(config.fromNumber) &&
    isE164PhoneNumber(config.callerNumber);

  const recordSuccess = async (createdAt: number): Promise<boolean> => {
    try {
      await config.recordSuccess({
        id: `twilio-call:${config.callSid}:caller-sms-handoff`,
        content: HANDOFF_HISTORY_CONTENT,
        createdAt,
      });
      return true;
    } catch (error) {
      // error-policy:J4 the transport succeeded, but canonical history remains
      // visibly pending and a later reconnect can repair it idempotently.
      logger.warn("[twilio-voice] caller SMS history persistence failed", {
        callSid: config.callSid,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const writeLedger = async (
    store: CallerSmsHandoffStore,
    key: string,
    entry: Exclude<HandoffLedgerEntry, { status: "pending" }>,
  ): Promise<boolean> => {
    try {
      await store.set(key, JSON.stringify(entry), {
        ex: HANDOFF_LEDGER_TTL_SECONDS,
      });
      return true;
    } catch (error) {
      // error-policy:J7 the original pending claim remains the fail-closed
      // duplicate fence; history persistence is still attempted separately.
      logger.warn("[twilio-voice] caller SMS ledger update failed", {
        callSid: config.callSid,
        status: entry.status,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  return async (transcript) => {
    const request = requestedSmsBody(transcript);
    if (request === null) return { handled: false };
    if (request === "unsupported_dictation") {
      return {
        handled: true,
        response:
          "I can only send the standard continuation text during a call. Say text me if you want that.",
      };
    }
    if (!numbersAreValidE164) {
      return {
        handled: true,
        response: "I can't safely text this call. We can keep going here.",
      };
    }
    const store = config.store;
    if (!store) {
      return {
        handled: true,
        response:
          "I can't safely text this call right now. We can keep going here.",
      };
    }
    const { key, providerToken } = await handoffIdentity(
      config.accountSid,
      config.callSid,
    );
    let claimed: unknown;
    try {
      claimed = await store.set(key, JSON.stringify({ status: "pending" }), {
        nx: true,
        ex: HANDOFF_LEDGER_TTL_SECONDS,
      });
    } catch (error) {
      // error-policy:J4 without a durable claim, sending could duplicate a
      // provider side effect after an isolate crash or stream reconnect.
      logger.warn("[twilio-voice] caller SMS claim unavailable", {
        callSid: config.callSid,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        handled: true,
        response:
          "I can't safely text this call right now. We can keep going here.",
      };
    }

    if (claimed === null || claimed === undefined) {
      let existing: HandoffLedgerEntry | null = null;
      try {
        existing = parseLedgerEntry(await store.get(key));
      } catch (error) {
        // error-policy:J4 unreadable durable state cannot authorize another send.
        logger.warn("[twilio-voice] caller SMS claim unreadable", {
          callSid: config.callSid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (existing?.status === "completed") {
        return { handled: true, response: "That text is already sent." };
      }
      if (existing?.status === "sent") {
        if (await recordSuccess(existing.createdAt)) {
          await writeLedger(store, key, {
            status: "completed",
            createdAt: existing.createdAt,
          });
        }
        return { handled: true, response: "That text is already sent." };
      }
      return {
        handled: true,
        response: "I'm already handling that text.",
      };
    }

    const params = new URLSearchParams({
      To: config.callerNumber,
      From: config.fromNumber,
      Body: DEFAULT_HANDOFF_BODY,
    });
    try {
      await send(config.accountSid, config.authToken, params, providerToken);
    } catch (error) {
      // error-policy:J4 Twilio rejection becomes an explicit spoken failure;
      // The provider may have accepted the request before the transport threw.
      // Retain the durable claim; a reconnect must not authorize another send.
      logger.warn("[twilio-voice] caller SMS handoff failed", {
        callSid: config.callSid,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        handled: true,
        response: "I couldn't send that text. We can keep going here.",
      };
    }

    const createdAt = now();
    await writeLedger(store, key, { status: "sent", createdAt });
    if (await recordSuccess(createdAt)) {
      await writeLedger(store, key, { status: "completed", createdAt });
    }
    return {
      handled: true,
      response: "Sent the continuation text to the number on this call.",
    };
  };
}
