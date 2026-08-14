/**
 * Versioned acknowledgement for the local realtime-voice ingress barrier.
 * A server may emit this value only after the exact user memory is durable or
 * an identical deterministic row has been verified. It says nothing about
 * model, assistant, tool, or room-owner settlement.
 */
export const REALTIME_VOICE_INGRESS_HEADER =
  "X-Eliza-Realtime-Voice-Ingress" as const;

export const REALTIME_VOICE_INGRESS_COMMITTED_V1 = "committed-v1" as const;

export function hasCommittedRealtimeVoiceIngress(headers: Headers): boolean {
  return (
    headers.get(REALTIME_VOICE_INGRESS_HEADER) ===
    REALTIME_VOICE_INGRESS_COMMITTED_V1
  );
}
