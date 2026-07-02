/**
 * React-Query data hooks for the org team credential pool (#11332).
 *
 * Same typed-client + invalidation pattern as `./use-organization`. Endpoints
 * (all masked — no key material ever crosses these; even the POST response is
 * the masked summary):
 * - `GET    /api/organizations/credentials`               list (ANY member)
 * - `POST   /api/organizations/credentials`               contribute (any member; live-probed)
 * - `PATCH  /api/organizations/credentials/:credentialId` enable/priority/label (owner/admin)
 * - `DELETE /api/organizations/credentials/:credentialId` remove (owner/admin or own contribution)
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import type { PooledCredentialDto } from "./cloud-org-types";

interface Envelope<T> {
  success?: boolean;
  data: T;
  error?: string;
}

export const credentialsQueryKey = [
  "cloud",
  "organization",
  "credentials",
] as const;

/** Pooled credentials, masked. Member-readable — no RBAC gate on the read. */
export function useOrganizationCredentials() {
  return useQuery<PooledCredentialDto[]>({
    queryKey: credentialsQueryKey,
    queryFn: async () => {
      const res = await api<Envelope<PooledCredentialDto[]>>(
        "/api/organizations/credentials",
      );
      return res.data;
    },
  });
}

export interface ContributeCredentialInput {
  provider: string;
  apiKey: string;
  label?: string;
  priority?: number;
}

/**
 * Contribute a provider API key to the pool. The backend live-probes the key
 * before pooling (400 with the probe message on failure) and returns the
 * MASKED summary — the plaintext never comes back.
 */
export function useContributeCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ContributeCredentialInput) => {
      const res = await api<Envelope<PooledCredentialDto>>(
        "/api/organizations/credentials",
        { method: "POST", json: input },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: credentialsQueryKey });
    },
  });
}

export interface UpdateCredentialInput {
  credentialId: string;
  enabled?: boolean;
  priority?: number;
  label?: string;
}

export function useUpdateCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ credentialId, ...patch }: UpdateCredentialInput) => {
      const res = await api<Envelope<PooledCredentialDto>>(
        `/api/organizations/credentials/${credentialId}`,
        { method: "PATCH", json: patch },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: credentialsQueryKey });
    },
  });
}

export function useRemoveCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (credentialId: string) => {
      await api(`/api/organizations/credentials/${credentialId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: credentialsQueryKey });
    },
  });
}
