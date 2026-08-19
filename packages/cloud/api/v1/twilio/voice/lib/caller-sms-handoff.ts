/**
 * Turns explicit caller-to-self SMS requests into bounded Twilio sends whose
 * destination and sender come only from authenticated, signed call claims.
 */

import { logger } from "@/lib/utils/logger";
import {
  isE164PhoneNumber,
  type TwilioSendMessageResponse,
  twilioApiRequest,
} from "@/lib/utils/twilio-api";

const DEFAULT_HANDOFF_BODY =
  "Eliza here — reply to this text to keep going after the call.";
const MAX_DICTATED_BODY_CHARS = 600;

export type CallerSmsHandoffResult =
  | { handled: false }
  | { handled: true; response: string };

export interface CallerSmsHandoffConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  callerNumber: string;
  send?: (
    accountSid: string,
    authToken: string,
    body: URLSearchParams,
  ) => Promise<void>;
}

function requestedSmsBody(transcript: string): string | null {
  const normalized = transcript.trim();
  if (
    /^(?:please\s+)?(?:text|sms)\s+me(?:\s+(?:a\s+)?(?:text|message|link))?[.!?]*$/i.test(
      normalized,
    )
  ) {
    return DEFAULT_HANDOFF_BODY;
  }
  const dictated = normalized.match(
    /^(?:please\s+)?(?:(?:text|sms)\s+me|send\s+me\s+(?:a\s+)?text)\s+(?:saying|with|this:)\s+(.+)$/i,
  )?.[1];
  return dictated?.trim() || null;
}

async function sendTwilioSms(
  accountSid: string,
  authToken: string,
  body: URLSearchParams,
): Promise<void> {
  await twilioApiRequest<TwilioSendMessageResponse>(
    accountSid,
    authToken,
    "POST",
    "/Messages.json",
    body,
  );
}

/** Build one call-scoped handler; successful duplicate requests send once. */
export function createCallerSmsHandoff(
  config: CallerSmsHandoffConfig,
): (transcript: string) => Promise<CallerSmsHandoffResult> {
  const send = config.send ?? sendTwilioSms;
  const completedBodies = new Set<string>();
  const sendsInFlight = new Map<string, Promise<boolean>>();
  const numbersAreVerified =
    isE164PhoneNumber(config.fromNumber) &&
    isE164PhoneNumber(config.callerNumber);

  return async (transcript) => {
    const body = requestedSmsBody(transcript);
    if (body === null) return { handled: false };
    if (!numbersAreVerified) {
      return {
        handled: true,
        response: "I can't safely text this call. We can keep going here.",
      };
    }
    if (body.length > MAX_DICTATED_BODY_CHARS) {
      return {
        handled: true,
        response: "That text is too long. Give me a shorter version.",
      };
    }
    if (completedBodies.has(body)) {
      return { handled: true, response: "That text is already sent." };
    }

    let pending = sendsInFlight.get(body);
    if (!pending) {
      const params = new URLSearchParams({
        To: config.callerNumber,
        From: config.fromNumber,
        Body: body,
      });
      pending = send(config.accountSid, config.authToken, params)
        .then(() => {
          completedBodies.add(body);
          return true;
        })
        .catch((error) => {
          // error-policy:J4 Twilio rejection becomes an explicit spoken
          // failure; the call continues without claiming the SMS was sent.
          logger.warn("[twilio-voice] caller SMS handoff failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        })
        .finally(() => sendsInFlight.delete(body));
      sendsInFlight.set(body, pending);
    }
    return (await pending)
      ? {
          handled: true,
          response: "Sent it to the number you're calling from.",
        }
      : {
          handled: true,
          response: "I couldn't send that text. We can keep going here.",
        };
  };
}
