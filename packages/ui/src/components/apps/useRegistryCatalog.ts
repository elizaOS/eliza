/**
 * Shared catalog fetch for views that need to resolve a slug against the
 * union of `client.listApps()` (installed) and `client.listCatalogApps()`
 * (registry). A module-level promise coalesces concurrent callers so two
 * views mounted for the same slug only hit the API once.
 */

import { useEffect, useState } from "react";
import { client, type RegistryAppInfo } from "../../api";

interface RegistryCatalogState {
  catalog: RegistryAppInfo[] | null;
  error: string | null;
}

let inflight: Promise<RegistryAppInfo[]> | null = null;

function fetchRegistryCatalog(): Promise<RegistryAppInfo[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    const [serverApps, catalogApps] = await Promise.all([
      client.listApps().catch(() => [] as RegistryAppInfo[]),
      client.listCatalogApps().catch(() => [] as RegistryAppInfo[]),
    ]);
    return [...catalogApps, ...serverApps].filter(
      (entry, index, items) =>
        !items
          .slice(index + 1)
          .some((candidate) => candidate.name === entry.name),
    );
  })().finally(() => {
    // Allow next mount cycle to refetch — keeps stale data out without
    // spamming the API for siblings mounting in the same tick.
    inflight = null;
  });
  return inflight;
}

export function useRegistryCatalog(): RegistryCatalogState {
  const [state, setState] = useState<RegistryCatalogState>({
    catalog: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetchRegistryCatalog().then(
      (catalog) => {
        if (cancelled) return;
        setState({ catalog, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({
          catalog: null,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
