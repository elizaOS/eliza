/**
 * Twilio connector contribution.
 *
 * Twilio doesn't have a `service-mixin-twilio.ts`; transport is owned by
 * `@elizaos/plugin-phone`. Credentials are read from `process.env` per the
 * legacy `readTwilioCredentialsFromEnv()` shape.
 *
 * Send target syntax:
 *   - SMS:   `"sms:+15551234567"` or just `"+15551234567"` (default).
 *   - Voice: `"voice:+15551234567"` (TwiML <Say> wrapping `payload.message`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
  sendTwilioVoiceCall,
  type TwilioCredentials,
  type TwilioDeliveryResult,
} from "@elizaos/plugin-phone/twilio";
import {
  type ConnectorSendPayload,
  dispatchReceipt,
  errorToDispatchResult,
  isConnectorSendPayload,
  missingProviderReceipt,
  rejectInvalidPayload,
} from "./_helpers.js";
import type {
  ConnectorContribution,
  ConnectorStatus,
  DispatchResult,
} from "./contract.js";

function parseTarget(target: string): {
  channel: "sms" | "voice";
  to: string;
} {
  const trimmed = target.trim();
  if (trimmed.startsWith("voice:")) {
    return { channel: "voice", to: trimmed.slice("voice:".length).trim() };
  }
  if (trimmed.startsWith("sms:")) {
    return { channel: "sms", to: trimmed.slice("sms:".length).trim() };
  }
  return { channel: "sms", to: trimmed };
}

function deliveryResultToDispatch(
  result: TwilioDeliveryResult,
  payload: ConnectorSendPayload,
): DispatchResult {
  if (result.ok) {
    const receipt = dispatchReceipt({
      provider: "twilio",
      providerMessageId: result.sid,
      payload,
    });
    if (!receipt) return missingProviderReceipt("Twilio");
    return {
      ok: true,
      messageId: result.sid,
      receipt,
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      reason: "auth_expired",
      acceptance: "not_accepted",
      userActionable: true,
      message: result.error ?? "Twilio rejected the request (auth).",
    };
  }
  if (result.status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      acceptance: "not_accepted",
      retryAfterMinutes: 5,
      userActionable: false,
      message: result.error ?? "Twilio rate limited.",
    };
  }
  if (result.status === 404 || result.status === 400) {
    return {
      ok: false,
      reason: "unknown_recipient",
      acceptance: "not_accepted",
      userActionable: true,
      message: result.error ?? "Twilio rejected the recipient.",
    };
  }
  return {
    ok: false,
    reason: "transport_error",
    acceptance: "unknown",
    userActionable: false,
    message: result.error ?? "Twilio delivery failed.",
  };
}

export function createTwilioConnectorContribution(
  _runtime: IAgentRuntime,
): ConnectorContribution {
  return {
    kind: "twilio",
    capabilities: ["twilio.sms.send", "twilio.voice.send"],
    modes: ["cloud"],
    describe: { label: "Twilio (SMS + Voice)" },
    receiptContract: "provider_receipt_id",
    async start() {},
    async disconnect() {
      // Twilio is configured via env vars; LifeOps doesn't manage credential
      // lifecycle. Operator clears env to disconnect.
    },
    async verify(): Promise<boolean> {
      return readTwilioCredentialsFromEnv() != null;
    },
    async status(): Promise<ConnectorStatus> {
      const credentials: TwilioCredentials | null =
        readTwilioCredentialsFromEnv();
      const observedAt = new Date().toISOString();
      if (!credentials) {
        return {
          state: "disconnected",
          message:
            "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
          observedAt,
        };
      }
      return { state: "ok", observedAt };
    },
    async send(payload: unknown): Promise<DispatchResult> {
      if (!isConnectorSendPayload(payload)) return rejectInvalidPayload();
      const credentials = readTwilioCredentialsFromEnv();
      if (!credentials) {
        return {
          ok: false,
          reason: "disconnected",
          acceptance: "not_accepted",
          userActionable: true,
          message:
            "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
        };
      }
      try {
        const { channel, to } = parseTarget(payload.target);
        if (!to) {
          return {
            ok: false,
            reason: "unknown_recipient",
            acceptance: "not_accepted",
            userActionable: true,
            message: "Twilio target is empty.",
          };
        }
        if (channel === "voice") {
          const result = await sendTwilioVoiceCall({
            credentials,
            to,
            message: payload.message,
          });
          return deliveryResultToDispatch(result, payload);
        }
        const result = await sendTwilioSms({
          credentials,
          to,
          body: payload.message,
        });
        return deliveryResultToDispatch(result, payload);
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
  };
}
