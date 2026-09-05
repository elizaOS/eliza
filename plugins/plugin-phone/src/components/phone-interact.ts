/**
 * Dispatches the Phone view bundle's classified interaction operations.
 * Keeping the exact handler map keyed by the production declaration union
 * makes an undeclared operation or an unimplemented declaration a type error.
 */

import { Phone } from "@elizaos/capacitor-phone";
import { ElizaError } from "@elizaos/core";
import type { PhoneViewCapabilityId } from "../view-capabilities.ts";
import {
  COMPLETE_CALL_LOG_READ_LIMIT,
  callLabelFor,
  loadPhoneState,
  normalizeNumber,
} from "./phone-view-helpers.ts";

type PhoneCapabilityHandler = (
  params?: Record<string, unknown>,
) => Promise<unknown>;

const PHONE_CAPABILITY_HANDLERS: Record<
  PhoneViewCapabilityId,
  PhoneCapabilityHandler
> = {
  "phone-state": async (params) => {
    const state = await loadPhoneState({
      complete: true,
      number: typeof params?.number === "string" ? params.number : undefined,
    });
    if (state.calls.length === COMPLETE_CALL_LOG_READ_LIMIT) {
      throw new ElizaError(
        "Phone-state read reached the native bridge boundary; refusing to return a potentially incomplete call log.",
        {
          code: "NATIVE_PHONE_STATE_READ_INCOMPLETE",
          context: { limit: COMPLETE_CALL_LOG_READ_LIMIT },
        },
      );
    }
    return {
      status: state.status,
      calls: state.calls.map((call) => ({
        id: call.id,
        number: call.number,
        cachedName: call.cachedName,
        label: callLabelFor(call),
        date: call.date,
        durationSeconds: call.durationSeconds,
        type: call.type,
        isNew: call.isNew,
        agentSummary: call.agentSummary,
        agentTranscript: call.agentTranscript,
      })),
    };
  },
  "place-call": async (params) => {
    const number = normalizeNumber(
      typeof params?.number === "string" ? params.number : "",
    );
    if (!number) throw new Error("number is required");
    await Phone.placeCall({ number });
    return { placed: true, number };
  },
  "open-dialer": async (params) => {
    const number = normalizeNumber(
      typeof params?.number === "string" ? params.number : "",
    );
    await Phone.openDialer(number ? { number } : undefined);
    return { opened: true, number: number || null };
  },
  "save-call-transcript": async (params) => {
    const callId =
      typeof params?.callId === "string" ? params.callId.trim() : "";
    const transcript =
      typeof params?.transcript === "string" ? params.transcript.trim() : "";
    const summary =
      typeof params?.summary === "string" ? params.summary.trim() : "";
    if (!callId) throw new Error("callId is required");
    if (!transcript) throw new Error("transcript is required");
    const result = await Phone.saveCallTranscript({
      callId,
      transcript,
      ...(summary ? { summary } : {}),
    });
    return { saved: true, updatedAt: result.updatedAt };
  },
};

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (!Object.hasOwn(PHONE_CAPABILITY_HANDLERS, capability)) {
    throw new Error(`Unsupported capability "${capability}"`);
  }
  return PHONE_CAPABILITY_HANDLERS[capability as PhoneViewCapabilityId](params);
}
