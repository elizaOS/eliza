import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export function useConnectionStatus<TStatus>(
  endpoint: string,
  errorMessage = "Failed to fetch connection status",
) {
  const [status, setStatus] = useState<TStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      try {
        const response = await fetch(endpoint, { signal });
        if (signal?.aborted) return;
        if (!response.ok) {
          throw new Error(errorMessage);
        }
        const data = (await response.json()) as TStatus;
        setStatus(data);
      } catch (error) {
        if (!signal?.aborted) {
          toast.error(error instanceof Error ? error.message : errorMessage);
        }
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [endpoint, errorMessage],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refetch(controller.signal);
    return () => controller.abort();
  }, [refetch]);

  return { status, isLoading, refetch };
}
