/** Fetches the account-native personal Eliza without depending on its runtime history. */

import type { PersonalElizaIdentityDto } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-eliza-identity";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../../lib/auth-query";

export type PersonalElizaIdentity = PersonalElizaIdentityDto;

interface PersonalElizaResponse {
  success: true;
  data: { identity: PersonalElizaIdentity };
}

export function usePersonalEliza() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["agent", "personal-eliza"], gate),
    queryFn: async () => {
      const response = await api<PersonalElizaResponse>(
        "/api/v1/eliza/personal",
      );
      return response.data.identity;
    },
    enabled: gate.enabled,
    refetchInterval: gate.enabled ? 15_000 : false,
  });
}
