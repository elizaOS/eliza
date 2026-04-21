import { useCallback, useEffect, useState } from "react";
import { client } from "../api";

function formatLifeOpsAppStateError(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message.trim()
    : "LifeOps app state failed to load.";
}

export function useLifeOpsAppState() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const state = await client.getLifeOpsAppState();
      setEnabled(state.enabled);
      setError(null);
      return state;
    } catch (cause) {
      setError(formatLifeOpsAppStateError(cause));
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const state = await client.getLifeOpsAppState();
        if (!active) {
          return;
        }
        setEnabled(state.enabled);
        setError(null);
      } catch (cause) {
        if (active) {
          setError(formatLifeOpsAppStateError(cause));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const updateEnabled = useCallback(async (nextEnabled: boolean) => {
    setSaving(true);
    try {
      const state = await client.updateLifeOpsAppState({
        enabled: nextEnabled,
      });
      setEnabled(state.enabled);
      setError(null);
      return state;
    } catch (cause) {
      setError(formatLifeOpsAppStateError(cause));
      throw cause;
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    enabled,
    loading,
    saving,
    error,
    refresh,
    updateEnabled,
  };
}
