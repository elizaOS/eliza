import { useMutation, useQueryClient } from "@tanstack/react-query";
import { elizacloudFetch } from "./client";
import { elizacloudKeys } from "./query-keys";

/**
 * Example mutation hook for elizacloud API.
 * Replace path, method, and types when you add real endpoints (e.g. chat send, auth).
 *
 * Usage:
 *   const sendMessage = useElizacloudMutation({ path: "/api/chat/send", method: "POST" });
 *   sendMessage.mutate({ body: { text: "hello" } });
 */
export function useElizacloudMutation<
  TBody = unknown,
  TResponse = unknown,
>(options: {
  path: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  invalidateKeys?: unknown[][];
}) {
  const queryClient = useQueryClient();
  const {
    path,
    method = "POST",
    invalidateKeys = [elizacloudKeys.all],
  } = options;

  return useMutation({
    mutationFn: async ({ body }: { body?: TBody }) => {
      const res = await elizacloudFetch<TResponse>(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res;
    },
    onSuccess: () => {
      invalidateKeys.forEach((key) => {
        queryClient.invalidateQueries({ queryKey: key });
      });
    },
  });
}
