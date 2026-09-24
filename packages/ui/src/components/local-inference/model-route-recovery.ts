/**
 * Recovers the composer's and download widget's read-only model-route probes.
 * Failed checks remain visible during bounded backoff; transport restoration
 * gives an exhausted probe another opportunity without reloading the page.
 */
import { client } from "../../api";
import { isApiError } from "../../api/client-types-core";
import { loadAfterCapabilityWarmup } from "../../hooks/runtime-capability-retry";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

export function observeModelRoute(
  read: (signal: AbortSignal) => Promise<number | null>,
  onFailure: () => void,
): { refresh: () => void; close: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let refreshPending = false;

  const refresh = () => {
    if (controller.signal.aborted) return;
    if (running) {
      refreshPending = true;
      return;
    }
    clearTimeout(timer);
    running = true;
    void loadAfterCapabilityWarmup(
      async () => {
        try {
          return await read(controller.signal);
        } catch (error) {
          // error-policy:J4 Preserve the visible failure while retrying the
          // read; neither reconnection nor a timer proves a working route.
          if (!controller.signal.aborted) onFailure();
          throw error;
        }
      },
      {
        signal: controller.signal,
        delaysMs: RETRY_DELAYS_MS,
        retryWhen: (error) =>
          !isApiError(error) ||
          error.status === undefined ||
          ![400, 401, 403, 422].includes(error.status),
      },
    )
      .then((recheckDelay) => {
        if (!controller.signal.aborted && recheckDelay !== null) {
          timer = setTimeout(refresh, recheckDelay);
        }
      })
      .catch(() => {
        // error-policy:J4 The owner already displays the last probe failure.
        // Exhaustion waits for transport restoration; teardown stays silent.
      })
      .finally(() => {
        running = false;
        if (refreshPending) {
          refreshPending = false;
          refresh();
        }
      });
  };

  const unsubscribe = client.onReconnect(refresh);
  window.addEventListener("online", refresh);
  window.addEventListener("focus", refresh);
  refresh();

  return {
    refresh,
    close: () => {
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    },
  };
}
