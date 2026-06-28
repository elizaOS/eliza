// View-bundle `interact` capability handler — the agent-facing terminal
// capability bridge for the Phone view. The view bundle re-exports `interact`
// via ./phone-view-bundle.ts.

import { Phone } from "@elizaos/capacitor-phone";
import {
  callLabelFor,
  loadPhoneState,
  normalizeNumber,
} from "./phone-view-helpers.ts";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-phone-state") {
    const state = await loadPhoneState({
      limit: params?.limit,
      number: typeof params?.number === "string" ? params.number : undefined,
    });
    return {
      viewType: "tui",
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
  }

  if (capability === "terminal-place-call") {
    const number = normalizeNumber(
      typeof params?.number === "string" ? params.number : "",
    );
    if (!number) throw new Error("number is required");
    await Phone.placeCall({ number });
    return { placed: true, number, viewType: "tui" };
  }

  if (capability === "terminal-open-dialer") {
    const number = normalizeNumber(
      typeof params?.number === "string" ? params.number : "",
    );
    await Phone.openDialer(number ? { number } : undefined);
    return { opened: true, number: number || null, viewType: "tui" };
  }

  if (capability === "terminal-save-call-transcript") {
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
    return { saved: true, updatedAt: result.updatedAt, viewType: "tui" };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
