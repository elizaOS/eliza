/**
 * Dispatches the Phone view bundle's classified interaction operations.
 * Keeping the exact handler map keyed by the production declaration union
 * makes an undeclared operation or an unimplemented declaration a type error.
 */

import { ElizaError } from "@elizaos/core/protocol";
import { Phone } from "@elizaos/plugin-native-phone/bridge";
import {
  callFromPhone,
  loadProfileRecents,
  openDialerFromPhone,
  telephonyProfile,
} from "../telephony-profile.ts";
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
    const profile = telephonyProfile();
    if (profile) {
      // Behind the telephony profile only the host's newest bounded page is
      // readable, and only with access the person already granted.
      const recents = await loadProfileRecents(profile);
      if (recents.access !== "granted")
        throw new ElizaError(
          recents.access === "needed"
            ? "Recent calls need call-history access, granted from the Phone view."
            : "Recent calls are not available on this phone.",
          { code: "NATIVE_PHONE_STATE_UNAVAILABLE" },
        );
      const number =
        typeof params?.number === "string"
          ? normalizeNumber(params.number)
          : "";
      return {
        status: { voiceCapable: recents.voiceCapable, dialHandoff: true },
        bounded: true,
        calls: recents.calls
          .filter((call) => !number || call.number === number)
          .map((call) => ({
            id: call.id,
            number: call.number,
            cachedName: call.cachedName,
            label: callLabelFor(call),
            date: call.date,
            durationSeconds: call.durationSeconds,
            type: call.type,
            isNew: call.isNew,
          })),
      };
    }
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
    const outcome = await callFromPhone(number);
    if (outcome.path === "direct") return { placed: true, number };
    // Behind the telephony profile the person places the call on the dial
    // screen; a handoff is never reported as a placed call.
    return {
      placed: false,
      handoff: outcome.result.status,
      handler: outcome.result.handler,
      number,
    };
  },
  "open-dialer": async (params) => {
    const number = normalizeNumber(
      typeof params?.number === "string" ? params.number : "",
    );
    const outcome = await openDialerFromPhone(number);
    if (outcome.path === "direct")
      return { opened: true, number: number || null };
    return {
      opened: outcome.result.status === "handed-off",
      handoff: outcome.result.status,
      number,
    };
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
    if (telephonyProfile())
      throw new Error(
        "Call transcripts are not stored behind the telephony profile",
      );
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
