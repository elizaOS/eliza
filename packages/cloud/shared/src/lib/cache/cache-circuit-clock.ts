import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";

export const CACHE_CIRCUIT_ID_PREFIX = "cache-circuit:";
export const CACHE_CIRCUIT_CLOCK_PATH = "/cache-circuit";
export const CACHE_CIRCUIT_COOLDOWN_MS = 60_000;

/** Reconcile one generation's original timer receipt, including an unknown acknowledgement. */
export async function readCacheCircuitClock(
  namespace: RuntimeDurableObjectNamespace,
  clientId: string,
  generation: number,
): Promise<boolean> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 1500);
  try {
    const response = await namespace
      .getByName(`${CACHE_CIRCUIT_ID_PREFIX}${clientId}`)
      .fetch(`https://cache-circuit.internal${CACHE_CIRCUIT_CLOCK_PATH}`, {
        method: "POST",
        body: JSON.stringify({ generation }),
        headers: { "content-type": "application/json" },
        signal: abort.signal,
      });
    if (!response.ok) throw new Error("Cache circuit clock did not confirm its receipt");
    const receipt = (await response.json()) as {
      clientId?: unknown;
      generation?: unknown;
      ready?: unknown;
    };
    if (
      receipt?.clientId !== clientId ||
      receipt.generation !== generation ||
      typeof receipt.ready !== "boolean"
    )
      throw new Error("Cache circuit clock returned a conflicting receipt");
    return receipt.ready;
  } finally {
    clearTimeout(timeout);
  }
}
