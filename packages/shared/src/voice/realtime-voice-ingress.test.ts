import { describe, expect, it } from "vitest";
import {
  hasCommittedRealtimeVoiceIngress,
  REALTIME_VOICE_INGRESS_COMMITTED_V1,
  REALTIME_VOICE_INGRESS_HEADER,
} from "./realtime-voice-ingress";

describe("realtime voice ingress acknowledgement", () => {
  it("accepts only the exact versioned durable-ingress acknowledgement", () => {
    const headers = new Headers({
      [REALTIME_VOICE_INGRESS_HEADER]: REALTIME_VOICE_INGRESS_COMMITTED_V1,
    });
    expect(hasCommittedRealtimeVoiceIngress(headers)).toBe(true);
    headers.set(REALTIME_VOICE_INGRESS_HEADER, "pending");
    expect(hasCommittedRealtimeVoiceIngress(headers)).toBe(false);
    headers.delete(REALTIME_VOICE_INGRESS_HEADER);
    expect(hasCommittedRealtimeVoiceIngress(headers)).toBe(false);
  });
});
