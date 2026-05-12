import type { Voice } from "@elizaos/cloud-ui";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

interface VoiceListResponse {
  success: boolean;
  voices: Voice[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// Voice catalog rarely changes; relax the global 30s staleTime to 10 minutes so
// nav between voice-using pages doesn't refetch the list every time.
const VOICE_STALE_MS = 10 * 60 * 1000;

export function useVoices() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["voices"], gate),
    queryFn: async () => {
      const data = await api<VoiceListResponse>("/api/v1/voice/list");
      return data.voices;
    },
    enabled: gate.enabled,
    staleTime: VOICE_STALE_MS,
  });
}

export function useVoice(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["voice", id], gate),
    queryFn: () => api<{ voice: Voice }>(`/api/v1/voice/${id}`).then((r) => r.voice),
    enabled: gate.enabled,
    staleTime: VOICE_STALE_MS,
  });
}
