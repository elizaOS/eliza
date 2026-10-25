/**
 * MCP registry mutations: create / update / delete / publish / unpublish.
 *
 * All write to the real `/api/v1/mcps` CRUD + `:mcpId/publish` routes through
 * the shared cloud `apiFetch` client (auth injection + structured `ApiError`)
 * and invalidate {@link MCPS_QUERY_KEY} so the list + detail re-fetch.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api-client";
import type {
  CreateUserMcpInput,
  CreateUserMcpResponse,
  MutateUserMcpResponse,
  UpdateUserMcpInput,
} from "./api-types";
import { MCPS_QUERY_KEY } from "./use-mcps";

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function useCreateMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateUserMcpInput) => {
      const res = await apiFetch("/api/v1/mcps", {
        method: "POST",
        json: input,
      });
      return readJson<CreateUserMcpResponse>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCPS_QUERY_KEY });
    },
  });
}

export function useUpdateMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      mcpId,
      input,
    }: {
      mcpId: string;
      input: UpdateUserMcpInput;
    }) => {
      const res = await apiFetch(`/api/v1/mcps/${mcpId}`, {
        method: "PUT",
        json: input,
      });
      return readJson<MutateUserMcpResponse>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCPS_QUERY_KEY });
    },
  });
}

export function useDeleteMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mcpId: string) => {
      await apiFetch(`/api/v1/mcps/${mcpId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCPS_QUERY_KEY });
    },
  });
}

export function usePublishMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mcpId: string) => {
      const res = await apiFetch(`/api/v1/mcps/${mcpId}/publish`, {
        method: "POST",
      });
      return readJson<MutateUserMcpResponse>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCPS_QUERY_KEY });
    },
  });
}

export function useUnpublishMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mcpId: string) => {
      const res = await apiFetch(`/api/v1/mcps/${mcpId}/publish`, {
        method: "DELETE",
      });
      return readJson<MutateUserMcpResponse>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCPS_QUERY_KEY });
    },
  });
}
