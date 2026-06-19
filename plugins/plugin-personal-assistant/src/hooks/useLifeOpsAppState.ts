import { client } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";

function errorMessage(cause: unknown): string {
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
      setEnabled(state.enabled === true);
      setError(null);
      return state;
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const state = await client.getLifeOpsAppState();
        if (cancelled) {
          return;
        }
        setEnabled(state.enabled === true);
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setError(errorMessage(cause));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateEnabled = useCallback(async (nextEnabled: boolean) => {
    setSaving(true);
    try {
      const state = await client.updateLifeOpsAppState({
        enabled: nextEnabled,
      });
      setEnabled(state.enabled === true);
      setError(null);
      return state;
    } catch (cause) {
      setError(errorMessage(cause));
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
