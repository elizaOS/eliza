/**
 * Synchronizes the mounted Notes view with the server-owned state document.
 * Revision ordering prevents a slow refresh or cross-view event from replacing
 * a newer mutation result, while explicit loading and error phases keep a
 * broken transport visually distinct from an empty notes collection.
 */

import { client } from "@elizaos/ui/api";
import { useViewEvent, VIEW_EVENTS } from "@elizaos/ui/events";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotesSnapshot } from "../types.js";
import {
  fetchNotesState,
  interact,
  NOTES_STATE_UPDATED_EVENT,
  NOTES_UPDATED_EVENT,
  type NotesInteractResult,
} from "./notesData.js";

export interface NotesState {
  snapshot: NotesSnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  mutate: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<NotesInteractResult>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Notes could not reach the local agent.";
}

export function useNotesState(): NotesState {
  const [snapshot, setSnapshot] = useState<NotesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const acceptSnapshot = useCallback((next: NotesSnapshot) => {
    if (!mounted.current) return;
    setSnapshot((current) =>
      current && current.revision > next.revision ? current : next,
    );
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (mounted.current) {
      setLoading(true);
      setError(null);
    }
    try {
      acceptSnapshot(await fetchNotesState());
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
  }, [acceptSnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useViewEvent(NOTES_STATE_UPDATED_EVENT, () => {
    void refresh();
  }, [refresh]);

  useViewEvent(NOTES_UPDATED_EVENT, () => {
    void refresh();
  }, [refresh]);

  useViewEvent(VIEW_EVENTS.VIEW_REFRESH, () => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const refreshAfterReconnect = () => {
      void refresh();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    const unsubscribeReconnect = client.onWsEvent(
      "ws-reconnected",
      refreshAfterReconnect,
    );
    window.addEventListener("online", refreshAfterReconnect);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      unsubscribeReconnect();
      window.removeEventListener("online", refreshAfterReconnect);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  const mutate = useCallback(
    async (capability: string, params?: Record<string, unknown>) => {
      if (mounted.current) {
        setBusy(true);
        setError(null);
      }
      try {
        const result = await interact(capability, params);
        acceptSnapshot(result.state);
        return result;
      } catch (cause) {
        // error-policy:J4 preserve visible state and surface the failed mutation.
        if (mounted.current) setError(errorMessage(cause));
        throw cause;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [acceptSnapshot],
  );

  return { snapshot, loading, busy, error, refresh, mutate };
}
