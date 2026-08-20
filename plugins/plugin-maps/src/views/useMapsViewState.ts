/**
 * Synchronizes the mounted /maps view with the server-owned snapshot and
 * tracks browser connectivity. Loading, error, offline, and designed-empty are
 * four distinguishable phases: a broken transport or lost network never renders
 * as an empty map.
 */

import { useViewEvent, VIEW_EVENTS } from "@elizaos/ui/events";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MapsViewSnapshot } from "../view-contract.js";
import {
  fetchMapsState,
  MAPS_STATE_UPDATED_EVENT,
  MAPS_UPDATED_EVENT,
} from "./mapsData.js";

export interface MapsViewState {
  snapshot: MapsViewSnapshot | null;
  loading: boolean;
  error: string | null;
  offline: boolean;
  refresh: () => Promise<void>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Maps could not reach the local agent.";
}

export function useMapsViewState(): MapsViewState {
  const [snapshot, setSnapshot] = useState<MapsViewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" && navigator.onLine === false,
  );
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (mounted.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await fetchMapsState();
      if (mounted.current && generation === refreshGeneration.current) {
        setSnapshot(next);
      }
    } catch (cause) {
      // error-policy:J4 render transport failure distinctly from empty state.
      if (mounted.current && generation === refreshGeneration.current) {
        setError(errorMessage(cause));
      }
    } finally {
      if (mounted.current && generation === refreshGeneration.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useViewEvent(MAPS_STATE_UPDATED_EVENT, () => {
    void refresh();
  }, [refresh]);
  useViewEvent(MAPS_UPDATED_EVENT, () => {
    void refresh();
  }, [refresh]);
  useViewEvent(VIEW_EVENTS.VIEW_REFRESH, () => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleOnline = () => {
      if (mounted.current) setOffline(false);
      void refresh();
    };
    const handleOffline = () => {
      if (mounted.current) setOffline(true);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  return { snapshot, loading, error, offline, refresh };
}
